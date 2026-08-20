import { mkdtemp, mkdir, readdir, rename, rm, stat, readFile, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnCapture } from './spawnCapture.js';
import { resolveDemucsBin, DEMUCS_MODEL } from './vocalActivity.js';

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
/** Provisional — full-track Demucs is unbenchmarked in this repo (see doc's 未決事項). */
export const STEM_SEPARATION_TIMEOUT_MS = 600_000;
/** Provisional cap — see doc's 未決事項. */
export const DEFAULT_STEM_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const META_FILE = 'meta.json';
const VOCAL_FILE = 'vocal.wav';
const INSTRUMENTAL_FILE = 'instrumental.wav';
/** @type {Map<string, Promise<{vocalPath:string,instrumentalPath:string}|null>>} */
const inFlight = new Map();

function entryDir(videoId) {
  return path.join(STEM_CACHE_DIR, videoId);
}

/**
 * @param {string} videoId
 * @returns {Promise<{ vocalPath: string, instrumentalPath: string } | null>}
 */
export async function getCachedStems(videoId) {
  if (!isSafeVideoId(videoId)) return null;
  const dir = entryDir(videoId);
  const vocalPath = path.join(dir, VOCAL_FILE);
  const instrumentalPath = path.join(dir, INSTRUMENTAL_FILE);
  try {
    const meta = JSON.parse(await readFile(path.join(dir, META_FILE), 'utf8'));
    // A model change invalidates every existing entry rather than mixing
    // separations from two different Demucs models across a session.
    if (meta.demucsModel !== DEMUCS_MODEL) return null;
    await access(vocalPath);
    await access(instrumentalPath);
    // Touch meta.json's mtime on every hit — pruneStemCache() sorts by each
    // entry's max file mtime, so without this a track reused on every
    // transition looks no more recent than one separated once and never
    // touched again, making eviction creation-order FIFO instead of LRU.
    // Best-effort: a failed touch must not turn a real cache hit into a miss.
    const now = new Date();
    await utimes(path.join(dir, META_FILE), now, now).catch(() => {});
    return { vocalPath, instrumentalPath };
  } catch {
    return null;
  }
}

/**
 * Full-track two-stem Demucs separation, written into the persistent cache.
 * Always cuts the input to a deterministically-named `input.wav` first
 * (matching vocalActivity.js's `combined.wav` convention) rather than
 * relying on Demucs' own basename-derived output subdirectory — the
 * downloaded track's temp path (normalize.js's `tempFilePath()`) has no
 * file extension, and this sidesteps needing to reason about how Demucs
 * would name that subdirectory.
 * @param {string} filePath already-downloaded/normalized full-track audio
 * @param {string} videoId
 * @param {{ spawnFn?: Function, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ vocalPath: string, instrumentalPath: string } | null>}
 */
export async function separateTrackStems(filePath, videoId, {
  spawnFn,
  timeoutMs = STEM_SEPARATION_TIMEOUT_MS,
  signal,
} = {}) {
  if (!filePath || !isSafeVideoId(videoId)) return null;
  if (signal?.aborted) return null;

  const cached = await getCachedStems(videoId);
  if (cached) return cached;

  const existing = inFlight.get(videoId);
  if (existing) return existing;

  // Dedup is per-videoId, shared across every caller currently awaiting it —
  // an abort from any one caller's signal cancels the shared in-flight job
  // for all of them, same as analysisQueue's own kill-current semantics
  // (queue-wide, not per-caller).
  const job = runSeparation(filePath, videoId, { spawnFn, timeoutMs, signal })
    .finally(() => inFlight.delete(videoId));
  inFlight.set(videoId, job);
  return job;
}

async function runSeparation(filePath, videoId, { spawnFn, timeoutMs, signal }) {
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
  try {
    const inputWav = path.join(jobTmpRoot, 'input.wav');
    const cut = await spawnCapture(spawnFn, 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-ac', '2', '-ar', '44100',
      inputWav,
    ], { timeoutMs, signal });
    if (cut.code !== 0) return null;
    if (signal?.aborted) return null;

    const demucsBin = resolveDemucsBin();
    const demucs = await spawnCapture(spawnFn, demucsBin, [
      '--two-stems=vocals',
      '-n', DEMUCS_MODEL,
      '-o', jobTmpRoot,
      inputWav,
    ], { timeoutMs, signal });
    if (demucs.code !== 0) return null;

    const stemDir = path.join(jobTmpRoot, DEMUCS_MODEL, 'input');
    const vocalsOut = path.join(stemDir, 'vocals.wav');
    const instrumentalOut = path.join(stemDir, 'no_vocals.wav');
    await access(vocalsOut);
    await access(instrumentalOut);

    const dir = entryDir(videoId);
    await mkdir(dir, { recursive: true });
    const vocalPath = path.join(dir, VOCAL_FILE);
    const instrumentalPath = path.join(dir, INSTRUMENTAL_FILE);
    await rename(vocalsOut, vocalPath);
    await rename(instrumentalOut, instrumentalPath);
    await writeFile(path.join(dir, META_FILE), JSON.stringify({
      demucsModel: DEMUCS_MODEL,
      separatedAt: Date.now(),
    }));
    // Enforce the size cap after every write, not just at Bot startup —
    // a long-running process would otherwise grow the cache unbounded.
    pruneStemCache().catch((err) => {
      console.warn(`[stemCache] prune after separation failed: ${err.message}`);
    });
    return { vocalPath, instrumentalPath };
  } catch (err) {
    console.warn(`[stemCache] separation failed for ${videoId}: ${err.message}`);
    return null;
  } finally {
    await rm(jobTmpRoot, { recursive: true, force: true }).catch(() => {});
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
