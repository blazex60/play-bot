import { mkdtemp, mkdir, readdir, rename, rm, stat, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnCapture } from './spawnCapture.js';
import { resolveDemucsBin, DEMUCS_MODEL } from './vocalActivity.js';

/**
 * Phase 8 (docs/mix-transition-phase8.md): a filesystem-only, PERSISTENT
 * stem cache — unlike every other temp-audio convention in this repo
 * (normalize.js's TEMP_DIR, vocalActivity.js's per-call mkdtemp), entries
 * here deliberately survive past the call that created them, because
 * full-track Demucs separation is expensive enough that recomputing it on
 * every transition attempt would defeat the point. No SQLite: the Bot
 * process never opens better-sqlite3 (CLAUDE.md) — cache membership is a
 * meta.json sidecar per entry, keyed by videoId.
 */
export const STEM_CACHE_DIR = path.join(tmpdir(), 'music-bot-stems');
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
  if (!videoId) return null;
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
 * @param {{ spawnFn?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<{ vocalPath: string, instrumentalPath: string } | null>}
 */
export async function separateTrackStems(filePath, videoId, {
  spawnFn,
  timeoutMs = STEM_SEPARATION_TIMEOUT_MS,
} = {}) {
  if (!filePath || !videoId) return null;

  const cached = await getCachedStems(videoId);
  if (cached) return cached;

  const existing = inFlight.get(videoId);
  if (existing) return existing;

  const job = runSeparation(filePath, videoId, { spawnFn, timeoutMs })
    .finally(() => inFlight.delete(videoId));
  inFlight.set(videoId, job);
  return job;
}

async function runSeparation(filePath, videoId, { spawnFn, timeoutMs }) {
  // Re-check inside the (de-duplicated) job in case a concurrent caller for
  // the same videoId finished between the caller's first check and now.
  const cached = await getCachedStems(videoId);
  if (cached) return cached;

  const jobTmpRoot = await mkdtemp(path.join(tmpdir(), 'musicbot-stemsep-'));
  try {
    const inputWav = path.join(jobTmpRoot, 'input.wav');
    const cut = await spawnCapture(spawnFn, 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-ac', '2', '-ar', '44100',
      inputWav,
    ], { timeoutMs });
    if (cut.code !== 0) return null;

    const demucsBin = resolveDemucsBin();
    const demucs = await spawnCapture(spawnFn, demucsBin, [
      '--two-stems=vocals',
      '-n', DEMUCS_MODEL,
      '-o', jobTmpRoot,
      inputWav,
    ], { timeoutMs });
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
