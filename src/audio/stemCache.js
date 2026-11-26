import { mkdtemp, mkdir, readdir, rename, rm, stat, readFile, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCapture } from './spawnCapture.js';
import { resolveDemucsBin, DEMUCS_MODEL } from './vocalActivity.js';
import { probeDurationSec } from './duration.js';
import { looksLikeCudaError, markCudaFailed, resolveDemucsDevice } from './demucsDevice.js';
import {
  estimateSeparationTimeoutMs,
  planStemWindows,
  stemSeparationConfig,
  stemWindowsAudioSec,
} from './stemConfig.js';
import { getLogger } from '../logging/appLogger.js';

const log = getLogger('stemCache');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Phase 8 (docs/mix-transition-phase8.md): a filesystem-only, PERSISTENT
 * stem cache — unlike every other temp-audio convention in this repo
 * (normalize.js's TEMP_DIR, vocalActivity.js's per-call mkdtemp), entries
 * here deliberately survive past the call that created them, because
 * full-track Demucs separation is expensive enough that recomputing it on
 * every transition attempt would defeat the point. No SQLite: the Bot
 * process never opens better-sqlite3 (CLAUDE.md) — cache membership is a
 * meta.json sidecar per entry, keyed by videoId.
 *
 * Lives under the repo's `data/` dir (docker-compose.yml mounts `./data` as
 * the only persistent volume) rather than os.tmpdir(), which is wiped on
 * every `docker compose up --build` redeploy — matching db/index.js's
 * DEFAULT_DB_PATH convention, including the env override.
 */
export const STEM_CACHE_DIR = process.env.MUSICBOT_STEM_CACHE_DIR
  ?? path.join(__dirname, '..', '..', 'data', 'stems');

/** Plain-identifier guard for videoId, which comes from external track
 * metadata, not a controlled allowlist — used as a path component below, so
 * a value containing `..` or a separator must never reach entryDir(). */
const SAFE_VIDEO_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isSafeVideoId(videoId) {
  return typeof videoId === 'string' && SAFE_VIDEO_ID.test(videoId);
}
/**
 * Upper bound for one Demucs run; the actual per-run timeout is derived from
 * how much audio is separated (stemConfig.js estimateSeparationTimeoutMs).
 * Kept as an export for callers/tests that reference the old constant.
 */
export const STEM_SEPARATION_TIMEOUT_MS = 600_000;
/** ffmpeg cutting one window out of the normalized file. */
const CUT_TIMEOUT_MS = 120_000;
/** Bumped when the on-disk layout changes; v1 = single full-track pair, no `windows`. */
const META_VERSION = 2;
/** Provisional cap — see doc's 未決事項. */
export const DEFAULT_STEM_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const META_FILE = 'meta.json';
const VOCAL_FILE = 'vocal.wav';
const INSTRUMENTAL_FILE = 'instrumental.wav';

/** 'full' keeps the original file names so v1 entries stay readable. */
function windowFileNames(name) {
  return name === 'full'
    ? { vocal: VOCAL_FILE, instrumental: INSTRUMENTAL_FILE }
    : { vocal: `${name}.${VOCAL_FILE}`, instrumental: `${name}.${INSTRUMENTAL_FILE}` };
}

/**
 * Circuit breaker (plan Phase 1 #7): after N consecutive failed separations
 * stop starting new ones for a cooldown, instead of burning a CPU core on
 * runs that keep timing out (production: 409/409 failed before this fix).
 */
const circuit = { consecutiveFailures: 0, openUntil: 0 };
let loggedDisabled = false;

export function resetStemCircuitForTest() {
  circuit.consecutiveFailures = 0;
  circuit.openUntil = 0;
  loggedDisabled = false;
}

function circuitOpen(now) {
  return circuit.openUntil > now;
}

function recordOutcome(ok, config, now) {
  if (ok) {
    circuit.consecutiveFailures = 0;
    return;
  }
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= config.circuitFailures && !circuitOpen(now)) {
    circuit.openUntil = now + config.circuitCooldownMs;
    log.warn({
      event: 'audio.stemcache.circuit_open',
      consecutiveFailures: circuit.consecutiveFailures,
      cooldownMs: config.circuitCooldownMs,
    }, 'ステム分離の連続失敗により一時停止');
    // Half-open after the cooldown: one more failure reopens immediately
    // instead of burning another N full-length runs to find out.
    circuit.consecutiveFailures = config.circuitFailures - 1;
  }
}

/** Whether new separations may start right now (feature switch + circuit breaker). */
export function isStemSeparationAvailable({ now = Date.now(), env = process.env } = {}) {
  const config = stemSeparationConfig(env);
  return config.enabled && !circuitOpen(now);
}
/** @type {Map<string, Promise<{vocalPath:string,instrumentalPath:string}|null>>} */
const inFlight = new Map();

function entryDir(videoId) {
  return path.join(STEM_CACHE_DIR, videoId);
}

/**
 * @param {string} videoId
 * @returns {Promise<{
 *   windows: { name: string, startSec: number, endSec: number|null, vocalPath: string, instrumentalPath: string }[],
 *   vocalPath?: string, instrumentalPath?: string,
 * } | null>} `vocalPath`/`instrumentalPath` are only set for a whole-track
 *   entry (kept for callers that predate windows); windowed entries must be
 *   read through `windows` (stemConfig.js findStemWindow()).
 */
export async function getCachedStems(videoId) {
  if (!isSafeVideoId(videoId)) return null;
  const dir = entryDir(videoId);
  try {
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8'));
    // A model change invalidates every existing entry rather than mixing
    // separations from two different Demucs models across a session.
    if (meta.demucsModel !== DEMUCS_MODEL) return null;
    const declared = Array.isArray(meta.windows) && meta.windows.length > 0
      ? meta.windows
      : [{ name: 'full', startSec: 0, endSec: null }];
    const windows = [];
    for (const w of declared) {
      const names = windowFileNames(w.name);
      const vocalPath = path.join(dir, names.vocal);
      const instrumentalPath = path.join(dir, names.instrumental);
      await access(vocalPath);
      await access(instrumentalPath);
      windows.push({ name: w.name, startSec: w.startSec ?? 0, endSec: w.endSec ?? null, vocalPath, instrumentalPath });
    }
    // Touch meta.json's mtime on every hit — pruneStemCache() sorts by each
    // entry's max file mtime, so without this a track reused on every
    // transition looks no more recent than one separated once and never
    // touched again, making eviction creation-order FIFO instead of LRU.
    // Best-effort: a failed touch must not turn a real cache hit into a miss.
    const now = new Date();
    await utimes(path.join(dir, META_FILE), now, now).catch(() => {});
    const full = windows.length === 1 && windows[0].name === 'full' ? windows[0] : null;
    return full
      ? { windows, vocalPath: full.vocalPath, instrumentalPath: full.instrumentalPath }
      : { windows };
  } catch {
    return null;
  }
}

/**
 * Two-stem Demucs separation of the windows a stem-mix transition can use,
 * written into the persistent cache (plan Phase 2). Tracks longer than
 * STEM_FULL_TRACK_MAX_SEC get only a head window (entry side) and a tail
 * window (exit side), cut from the normalized file and fed to ONE Demucs
 * process so the model loads once; shorter tracks and tracks of unknown
 * length are separated whole. Each window is cut to a deterministically
 * named WAV (`head.wav`, `tail.wav`, or `input.wav` for the whole track)
 * so Demucs' basename-derived output directory is predictable — the
 * downloaded track's temp path has no file extension.
 * @param {string} filePath already-downloaded/normalized full-track audio
 * @param {string} videoId
 * @param {{ spawnFn?: Function, timeoutMs?: number, signal?: AbortSignal,
 *   getPausedMs?: () => number, probeDurationFn?: Function, env?: object }} [opts]
 *   `timeoutMs` overrides the duration-derived Demucs timeout.
 * @returns {Promise<object | null>} getCachedStems()'s shape
 */
export async function separateTrackStems(filePath, videoId, {
  spawnFn,
  timeoutMs,
  signal,
  getPausedMs,
  probeDurationFn = probeDurationSec,
  env = process.env,
  deviceFn = resolveDemucsDevice,
} = {}) {
  if (!filePath || !isSafeVideoId(videoId)) return null;
  if (signal?.aborted) return null;
  const config = stemSeparationConfig(env);
  if (!config.enabled) {
    if (!loggedDisabled) {
      loggedDisabled = true;
      log.info({ event: 'audio.stemcache.disabled' }, 'ステム分離は無効化されています');
    }
    return null;
  }

  const cached = await getCachedStems(videoId);
  if (cached) return cached;

  const existing = inFlight.get(videoId);
  if (existing) return existing;

  // Dedup is per-videoId, shared across every caller currently awaiting it —
  // an abort from any one caller's signal cancels the shared in-flight job
  // for all of them, same as analysisQueue's own kill-current semantics
  // (queue-wide, not per-caller).
  if (circuitOpen(Date.now())) {
    log.debug({ event: 'audio.stemcache.skipped_circuit_open', trackId: videoId }, 'ステム分離は一時停止中のためスキップ');
    return null;
  }

  const job = runSeparation(filePath, videoId, { spawnFn, timeoutMs, signal, getPausedMs, probeDurationFn, config, env, deviceFn })
    .finally(() => inFlight.delete(videoId));
  inFlight.set(videoId, job);
  return job;
}

async function runSeparation(filePath, videoId, { spawnFn, timeoutMs, signal, getPausedMs, probeDurationFn, config, env, deviceFn }) {
  // Re-check inside the (de-duplicated) job in case a concurrent caller for
  // the same videoId finished between the caller's first check and now.
  const cached = await getCachedStems(videoId);
  if (cached) return cached;

  // Staged under STEM_CACHE_DIR itself, NOT os.tmpdir() — the eventual
  // rename() below must land on the same filesystem as its source, or it
  // fails with EXDEV. In the production container STEM_CACHE_DIR resolves
  // under the bind-mounted ./data volume while os.tmpdir() is the
  // container's own /tmp, a different filesystem entirely.
  await mkdir(STEM_CACHE_DIR, { recursive: true });
  const jobTmpRoot = await mkdtemp(path.join(STEM_CACHE_DIR, '.stemsep-'));
  const startedAt = Date.now();
  let trackDurationSec = null;
  let audioSec = null;
  let demucsTimeoutMs = null;
  let windows = [];
  let usedDevice = null;
  try {
    trackDurationSec = await probeDurationFn(filePath, { spawnFn }).catch(() => null);
    if (signal?.aborted) return null;
    // Without a length there is no tail window to cut, and separating the
    // whole file is exactly the run that kept timing out in production.
    // Not counted against the circuit breaker: nothing was attempted.
    if (!Number.isFinite(trackDurationSec) || trackDurationSec <= 0) {
      log.info({ event: 'audio.stemcache.skipped_unknown_duration', trackId: videoId }, '曲の長さが取れないためステム分離をスキップ');
      return null;
    }
    // GPU: whole track (~30 s). CPU: head/tail windows. A CUDA-looking
    // failure degrades the process to CPU and this job is retried once there.
    const attempt = async (device) => {
      const runConfig = stemSeparationConfig(env, { device });
      windows = planStemWindows(trackDurationSec, { wholeTrack: device === 'cuda' });
      audioSec = stemWindowsAudioSec(windows);
      demucsTimeoutMs = timeoutMs ?? estimateSeparationTimeoutMs(audioSec, runConfig);
      usedDevice = device;
      const inputs = [];
      for (const w of windows) {
        const base = w.name === 'full' ? 'input' : w.name;
        const wav = path.join(jobTmpRoot, `${base}.wav`);
        const args = ['-hide_banner', '-loglevel', 'error', '-y'];
        if (w.name !== 'full') args.push('-ss', w.startSec.toFixed(3), '-t', (w.endSec - w.startSec).toFixed(3));
        args.push('-i', filePath, '-ac', '2', '-ar', '44100', wav);
        const cut = await spawnCapture(spawnFn, 'ffmpeg', args, { timeoutMs: CUT_TIMEOUT_MS, signal, getPausedMs });
        if (cut.code !== 0) throw new Error(`ffmpeg cut of ${w.name} window exited with ${cut.code}`);
        if (signal?.aborted) return null;
        inputs.push({ window: w, wav, base });
      }
      let demucs;
      try {
        demucs = await spawnCapture(spawnFn, resolveDemucsBin(), [
          '--two-stems=vocals',
          '-n', DEMUCS_MODEL,
          '-d', device,
          '-o', jobTmpRoot,
          ...inputs.map((i) => i.wav),
        ], { timeoutMs: demucsTimeoutMs, signal, getPausedMs });
      } catch (err) {
        // A hung GPU (driver wedge, lost passthrough) shows up as a timeout
        // with nothing CUDA-ish in stderr; treat it as a CUDA failure so the
        // following jobs stop waiting on the GPU too.
        if (err?.timedOut && device === 'cuda') err.cudaRelated = true;
        throw err;
      }
      if (demucs.code !== 0) {
        const tail = demucs.stderr?.trim().split('\n').slice(-5).join('\n') ?? '';
        const err = new Error(`demucs exited with ${demucs.code}: ${tail.split('\n').slice(-3).join(' | ')}`);
        err.cudaRelated = device === 'cuda' && looksLikeCudaError(tail);
        throw err;
      }
      return inputs;
    };

    const device = await deviceFn({ env });
    let inputs;
    try {
      inputs = await attempt(device);
    } catch (err) {
      if (!err?.cudaRelated || signal?.aborted) throw err;
      markCudaFailed(err);
      inputs = await attempt('cpu');
    }
    if (!inputs) return null;

    const outputs = [];
    for (const { window: w, base } of inputs) {
      const stemDir = path.join(jobTmpRoot, DEMUCS_MODEL, base);
      const vocalsOut = path.join(stemDir, 'vocals.wav');
      const instrumentalOut = path.join(stemDir, 'no_vocals.wav');
      await access(vocalsOut);
      await access(instrumentalOut);
      outputs.push({ window: w, vocalsOut, instrumentalOut });
    }

    const dir = entryDir(videoId);
    await mkdir(dir, { recursive: true });
    for (const { window: w, vocalsOut, instrumentalOut } of outputs) {
      const names = windowFileNames(w.name);
      await rename(vocalsOut, path.join(dir, names.vocal));
      await rename(instrumentalOut, path.join(dir, names.instrumental));
    }
    // meta.json last: getCachedStems() treats its presence as "entry complete".
    await writeFile(path.join(dir, META_FILE), JSON.stringify({
      version: META_VERSION,
      demucsModel: DEMUCS_MODEL,
      separatedAt: Date.now(),
      trackDurationSec,
      windows: windows.map(({ name, startSec, endSec }) => ({ name, startSec, endSec })),
    }));
    // Enforce the size cap after every write, not just at Bot startup —
    // a long-running process would otherwise grow the cache unbounded.
    pruneStemCache().catch((err) => {
      log.warn({ event: 'audio.stemcache.prune_failed', err }, '分離後のキャッシュ整理に失敗');
    });
    const elapsedMs = Date.now() - startedAt;
    const pausedMs = getPausedMs?.() ?? 0;
    recordOutcome(true, config, Date.now());
    log.info({
      event: 'audio.stemcache.separated',
      trackId: videoId,
      windows: windows.map((w) => w.name),
      audioSec,
      trackDurationSec,
      elapsedMs,
      pausedMs,
      // Compute seconds per audio second, excluding time the queue froze
      // the job — the number to calibrate STEM_SEPARATION_RTF against.
      rtf: audioSec ? Number(((elapsedMs - pausedMs) / 1000 / audioSec).toFixed(3)) : null,
      threads: usedDevice === 'cuda' ? undefined : config.threads,
      device: usedDevice,
    }, 'ステム分離に成功');
    return getCachedStems(videoId);
  } catch (err) {
    if (signal?.aborted) return null;
    recordOutcome(false, config, Date.now());
    log.warn({
      event: 'audio.stemcache.separation_failed',
      trackId: videoId,
      windows: windows.map((w) => w.name),
      audioSec,
      trackDurationSec,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: demucsTimeoutMs,
      threads: usedDevice === 'cuda' ? undefined : config.threads,
      device: usedDevice,
      err,
    }, 'ステム分離に失敗');
    return null;
  } finally {
    await rm(jobTmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Removes every `.stemsep-*` staging directory left under STEM_CACHE_DIR —
 * runSeparation()'s own `finally` block already removes its staging dir on
 * every normal exit (success, failure, or an aborted signal), but a killed
 * process or a recreated container skips that `finally` entirely, orphaning
 * the directory (and its input WAV / partial Demucs output) on the
 * persistent volume forever. pruneStemCache() deliberately skips anything
 * that isn't a valid videoId shape so it never touches a currently-running
 * job's staging dir mid-write (see its own comment) — which also means an
 * orphan's bytes are silently excluded from the 2GB accounting, and repeated
 * interrupted deployments can eventually fill the volume.
 *
 * Only safe to call at startup, before this process could have created any
 * `.stemsep-*` directory of its own — call it once, alongside
 * pruneStemCache(), not on every prune (unlike pruneStemCache(), a mid-run
 * call here WOULD delete an active job's staging dir).
 */
export async function cleanupStaleStemStaging() {
  let entries;
  try {
    entries = await readdir(STEM_CACHE_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.stemsep-')) continue;
    await rm(path.join(STEM_CACHE_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Size-capped, LRU-by-mtime eviction — unlike normalize.js's
 * cleanupStaleTempDir(), this must NOT wipe the whole directory on every
 * call, or the cache never pays for itself. Call once at startup.
 * @param {{ maxBytes?: number }} [opts]
 */
export async function pruneStemCache({ maxBytes = DEFAULT_STEM_CACHE_MAX_BYTES } = {}) {
  let entries;
  try {
    entries = await readdir(STEM_CACHE_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  const sized = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // runSeparation()'s staging dirs (`.stemsep-*`, cleaned up in its own
    // finally block) now live alongside real videoId entries under
    // STEM_CACHE_DIR — never a valid videoId shape (isSafeVideoId requires
    // [A-Za-z0-9_-]), so skip anything that isn't one rather than risking
    // an in-progress separation's staging dir getting evicted mid-write.
    if (!isSafeVideoId(entry.name)) continue;
    const dirPath = path.join(STEM_CACHE_DIR, entry.name);
    let totalBytes = 0;
    let mtimeMs = 0;
    try {
      const files = await readdir(dirPath);
      for (const file of files) {
        const st = await stat(path.join(dirPath, file));
        totalBytes += st.size;
        mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      }
    } catch {
      continue;
    }
    sized.push({ dirPath, totalBytes, mtimeMs });
  }

  let total = sized.reduce((sum, e) => sum + e.totalBytes, 0);
  if (total <= maxBytes) return;

  sized.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of sized) {
    if (total <= maxBytes) break;
    await rm(entry.dirPath, { recursive: true, force: true }).catch(() => {});
    total -= entry.totalBytes;
  }
}
