import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAnalysisQueue } from './analysisQueue.js';
import { spawnCapture } from './spawnCapture.js';

/** Relative threshold: vocals are "present" when within this dB of the mix. */
export const VOCAL_RELATIVE_DB = 25;
/** Absolute floor — below this, treat as silence even if close to a quiet mix. */
export const VOCAL_ABS_DB = -50;
// Phase 9F §8.2: widen the tail analysis window from the original 45s into
// the spec's 60-90s range so exit candidates further from EOF (e.g. a
// phrase-boundary 16 bars out at a slow tempo, which can exceed 45s) become
// reachable. 60s (the low end of the range) is a deliberate choice: it's the
// minimum needed for a full 16-bar reach down to ~64 BPM (16 bars @ 4/4 =
// 60s at 64 BPM), while keeping the added Demucs tail-window compute cost to
// ~33% instead of the ~100% a 90s window would add per track analyzed.
export const TAIL_WINDOW_SEC = 60;
/** Phase 7 §2.4: entry-point search needs to know where singing starts. */
export const HEAD_WINDOW_SEC = 30;
export const VOCAL_FRAME_SEC = 0.1;
export const VOCAL_GAP_MIN_SEC = 1.5;
export const DEMUCS_MODEL = 'htdemucs';
// astats' `reset` option is a frame count, not seconds — asetnsamples forces
// one filter-frame per VOCAL_FRAME_SEC at a known rate so reset=1 actually
// means "one RMS_level print per 100ms" (see downbeatAnalysis.js for the
// same fix, and why -loglevel error would also silently drop this output).
const VOCAL_ENVELOPE_SAMPLE_RATE = 44100;
const VOCAL_ENVELOPE_SAMPLES_PER_FRAME = Math.round(VOCAL_ENVELOPE_SAMPLE_RATE * VOCAL_FRAME_SEC);

// A digitally silent 100ms block reports RMS_level=-inf, which the old
// [-0-9.]+ pattern couldn't match at all — the frame was silently dropped,
// shifting every later index one position early relative to real time. That
// broke any fixed-cadence indexing over the result (buildLevelLookup(),
// vocalActivity's head/tail slice indices, phrase feature lookups). -100dB
// is safely below every silence/vocal threshold that consumes this array
// (VOCAL_ABS_DB=-50, PHRASE_SILENCE_DB=-45), so it keeps the same
// "silent" classification while preserving frame alignment.
const SILENT_RMS_DB = -100;

export function parseRmsLevels(stderr) {
  return [...String(stderr ?? '').matchAll(/RMS_level=(-inf|inf|[-0-9.]+)/g)]
    .map((m) => {
      if (m[1] === '-inf') return SILENT_RMS_DB;
      if (m[1] === 'inf') return -SILENT_RMS_DB;
      return Number(m[1]);
    })
    .filter((n) => Number.isFinite(n));
}

function isVocalFrame(vocalDb, mixDb) {
  if (!Number.isFinite(vocalDb)) return false;
  if (vocalDb <= VOCAL_ABS_DB) return false;
  if (Number.isFinite(mixDb) && vocalDb <= mixDb - VOCAL_RELATIVE_DB) return false;
  return true;
}

function flagFrames(vocalLevels, mixLevels) {
  const n = Math.max(vocalLevels.length, mixLevels.length);
  const flags = [];
  for (let i = 0; i < n; i += 1) {
    flags.push(isVocalFrame(vocalLevels[i], mixLevels[i]));
  }
  return flags;
}

function findVocalGaps(flags, anchorSec, frameSec) {
  const gaps = [];
  let gapStart = null;
  for (let i = 0; i < flags.length; i += 1) {
    if (!flags[i]) {
      if (gapStart == null) gapStart = i;
    } else if (gapStart != null) {
      const startSec = anchorSec + gapStart * frameSec;
      const endSec = anchorSec + i * frameSec;
      if (endSec - startSec >= VOCAL_GAP_MIN_SEC) gaps.push({ startSec, endSec });
      gapStart = null;
    }
  }
  if (gapStart != null) {
    const startSec = anchorSec + gapStart * frameSec;
    const endSec = anchorSec + flags.length * frameSec;
    if (endSec - startSec >= VOCAL_GAP_MIN_SEC) gaps.push({ startSec, endSec });
  }
  return gaps;
}

/**
 * Classify 100ms RMS envelopes from Demucs vocals vs the mix tail.
 * @param {{ vocalLevels: number[], mixLevels: number[], tailStartSec: number, frameSec?: number }} args
 */
export function classifyVocalEnvelope({
  vocalLevels,
  mixLevels,
  tailStartSec,
  frameSec = VOCAL_FRAME_SEC,
}) {
  const flags = flagFrames(vocalLevels, mixLevels);
  const n = flags.length;

  const vocalConfidence = n >= 5 ? 0.85 : n > 0 ? 0.5 : 0;
  if (flags.every((v) => !v)) {
    return {
      ok: true,
      lastVocalEndSec: tailStartSec,
      vocalGaps: n > 0
        ? [{ startSec: tailStartSec, endSec: tailStartSec + n * frameSec }]
        : [],
      vocalConfidence,
      source: 'demucs',
    };
  }

  let lastVocalIndex = -1;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) lastVocalIndex = i;
  }
  const lastVocalEndSec = tailStartSec + (lastVocalIndex + 1) * frameSec;

  return {
    ok: true,
    lastVocalEndSec,
    vocalGaps: findVocalGaps(flags, tailStartSec, frameSec),
    vocalConfidence,
    source: 'demucs',
  };
}

/**
 * Head-window counterpart of `classifyVocalEnvelope()` — Phase 7 §2.4/§10
 * needs to know where singing *starts* (and any silence gaps within the
 * head window) to pick incoming entry points before the vocal begins.
 * @param {{ vocalLevels: number[], mixLevels: number[], headStartSec: number, frameSec?: number }} args
 */
export function classifyFirstVocalStart({
  vocalLevels,
  mixLevels,
  headStartSec,
  frameSec = VOCAL_FRAME_SEC,
}) {
  const flags = flagFrames(vocalLevels, mixLevels);

  let firstVocalIndex = -1;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) {
      firstVocalIndex = i;
      break;
    }
  }
  const firstVocalStartSec = firstVocalIndex === -1
    ? null
    : headStartSec + firstVocalIndex * frameSec;

  return {
    firstVocalStartSec,
    headVocalGaps: findVocalGaps(flags, headStartSec, frameSec),
  };
}

async function rmsEnvelope(spawnFn, filePath) {
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', filePath,
    '-af',
    `aresample=${VOCAL_ENVELOPE_SAMPLE_RATE},asetnsamples=n=${VOCAL_ENVELOPE_SAMPLES_PER_FRAME}:p=0,`
      + 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  return {
    ok: code === 0,
    levels: parseRmsLevels(stderr),
  };
}

export function resolveDemucsBin() {
  return process.env.DEMUCS_BIN
    || (process.env.DEMUCS_VENV ? path.join(process.env.DEMUCS_VENV, 'bin', 'demucs') : 'demucs');
}

async function cutClip(run, filePath, outPath, { startSec = null, lengthSec = null } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSec != null) args.push('-ss', String(startSec));
  args.push('-i', filePath);
  if (lengthSec != null) args.push('-t', String(lengthSec));
  args.push('-ac', '2', '-ar', '44100', outPath);
  return spawnCapture(run, 'ffmpeg', args);
}

async function runDemucsVocals(run, tmpRoot, combinedWav) {
  const demucsBin = resolveDemucsBin();
  const demucs = await spawnCapture(run, demucsBin, [
    '--two-stems=vocals',
    '-n', DEMUCS_MODEL,
    '-o', tmpRoot,
    combinedWav,
  ], { timeoutMs: 300_000 });
  if (demucs.code !== 0) return null;
  return path.join(tmpRoot, DEMUCS_MODEL, 'combined', 'vocals.wav');
}

// Factory (not a shared constant): callers/consumers must never be able to
// mutate one failure's arrays and have that leak into the next call.
function emptyResult() {
  return {
    ok: false,
    lastVocalEndSec: null,
    vocalGaps: [],
    vocalConfidence: 0,
    source: 'none',
    firstVocalStartSec: null,
    headVocalGaps: [],
  };
}

/**
 * Analyze both the head window (§2.4 — where does singing start) and the
 * tail window (Phase 6 — where does singing end) with a *single* Demucs
 * invocation: the two windows are cut and concatenated into one clip before
 * separation, instead of running `--two-stems=vocals` twice per track.
 * @param {string} filePath
 * @param {{ durationSec: number, tailWindowSec?: number, headWindowSec?: number, queue?: object, spawnFn?: Function }} [opts]
 */
export async function analyzeVocalActivity(filePath, {
  durationSec,
  tailWindowSec = TAIL_WINDOW_SEC,
  headWindowSec = HEAD_WINDOW_SEC,
  queue = null,
  spawnFn = null,
} = {}) {
  if (!filePath || !(durationSec > 0)) return emptyResult();

  const analysisQueue = queue ?? getAnalysisQueue();
  const run = spawnFn ?? ((cmd, args, options) => analysisQueue.spawn(cmd, args, options));

  const headStart = 0;
  const headLen = Math.min(headWindowSec, durationSec);
  const tailStart = Math.max(0, durationSec - tailWindowSec);
  const tailLen = Math.min(tailWindowSec, durationSec);
  // Short track: the two windows cover (nearly) the whole file, so there is
  // nothing to gain from cutting/concatenating — analyze it as one clip.
  const overlap = headStart + headLen >= tailStart;

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'musicbot-vocal-'));

  try {
    const combinedWav = path.join(tmpRoot, 'combined.wav');
    // Index range each window occupies within the combined clip's envelope,
    // so both branches below share one slice-then-classify path instead of
    // treating the whole clip as both windows at once (which leaked
    // out-of-window activity into firstVocalStartSec/headVocalGaps/vocalGaps
    // for tracks between headWindowSec and tailWindowSec+headWindowSec long).
    let headSliceEnd;
    let tailSliceStart;

    if (overlap) {
      const cut = await cutClip(run, filePath, combinedWav);
      if (cut.code !== 0) return emptyResult();
      headSliceEnd = Math.round(headLen / VOCAL_FRAME_SEC);
      tailSliceStart = Math.round(tailStart / VOCAL_FRAME_SEC);
    } else {
      const headWav = path.join(tmpRoot, 'head.wav');
      const tailWav = path.join(tmpRoot, 'tail.wav');
      const [headCut, tailCut] = await Promise.all([
        cutClip(run, filePath, headWav, { startSec: headStart, lengthSec: headLen }),
        cutClip(run, filePath, tailWav, { startSec: tailStart, lengthSec: tailLen }),
      ]);
      if (headCut.code !== 0 || tailCut.code !== 0) return emptyResult();

      const concat = await spawnCapture(run, 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', headWav, '-i', tailWav,
        '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
        combinedWav,
      ]);
      if (concat.code !== 0) return emptyResult();
      headSliceEnd = Math.round(headLen / VOCAL_FRAME_SEC);
      tailSliceStart = headSliceEnd;
    }

    const vocalsWav = await runDemucsVocals(run, tmpRoot, combinedWav);
    if (!vocalsWav) return emptyResult();

    const [vocalEnv, mixEnv] = await Promise.all([
      rmsEnvelope(run, vocalsWav),
      rmsEnvelope(run, combinedWav),
    ]);
    if (!vocalEnv.ok || vocalEnv.levels.length === 0) return emptyResult();
    if (!mixEnv.ok || mixEnv.levels.length === 0) return emptyResult();

    // In the overlap branch the tail window ends mid-clip (tailStart +
    // tailLen), not at the envelope's end — the concatenated branch's tail
    // segment, by contrast, runs to the array end since nothing follows it.
    const tailSliceEnd = overlap ? Math.round((tailStart + tailLen) / VOCAL_FRAME_SEC) : undefined;

    const tailResult = classifyVocalEnvelope({
      vocalLevels: vocalEnv.levels.slice(tailSliceStart, tailSliceEnd),
      mixLevels: mixEnv.levels.slice(tailSliceStart, tailSliceEnd),
      tailStartSec: tailStart,
    });
    const headResult = classifyFirstVocalStart({
      vocalLevels: vocalEnv.levels.slice(0, headSliceEnd),
      mixLevels: mixEnv.levels.slice(0, headSliceEnd),
      headStartSec: headStart,
    });
    return { ...tailResult, ...headResult };
  } catch {
    return emptyResult();
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function defaultSpawn(cmd, args, options) {
  return spawn(cmd, args, options);
}
