import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAnalysisQueue } from './analysisQueue.js';
import { spawnCapture } from './spawnCapture.js';
import { findStemWindow } from './stemConfig.js';
import { looksLikeCudaError, markCudaFailed, resolveDemucsDevice } from './demucsDevice.js';

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

async function runDemucsVocals(run, tmpRoot, combinedWav, { deviceFn = resolveDemucsDevice } = {}) {
  const demucsBin = resolveDemucsBin();
  const once = (device) => spawnCapture(run, demucsBin, [
    '--two-stems=vocals',
    '-n', DEMUCS_MODEL,
    '-d', device,
    '-o', tmpRoot,
    combinedWav,
  ], { timeoutMs: 300_000 });
  // Same device policy as stemCache: honor DEMUCS_DEVICE, and a CUDA failure
  // (CUDA-looking stderr or a timeout) degrades the process to CPU and this
  // clip is retried there once.
  const device = await deviceFn();
  let demucs;
  try {
    demucs = await once(device);
  } catch (err) {
    if (device !== 'cuda' || !err?.timedOut) throw err;
    markCudaFailed(err);
    demucs = await once('cpu');
  }
  if (demucs.code !== 0 && device === 'cuda'
    && looksLikeCudaError(demucs.stderr?.trim().split('\n').slice(-5).join('\n'))) {
    markCudaFailed(new Error(`demucs exited with ${demucs.code}`));
    demucs = await once('cpu');
  }
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
 * @param {{ durationSec: number, tailWindowSec?: number, headWindowSec?: number, queue?: object, spawnFn?: Function, deviceFn?: Function }} [opts]
 */
export async function analyzeVocalActivity(filePath, {
  durationSec,
  tailWindowSec = TAIL_WINDOW_SEC,
  headWindowSec = HEAD_WINDOW_SEC,
  queue = null,
  spawnFn = null,
  deviceFn = resolveDemucsDevice,
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

    const vocalsWav = await runDemucsVocals(run, tmpRoot, combinedWav, { deviceFn });
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

/**
 * RMS envelope of one segment of one or more files, summed. With two
 * inputs (vocal + instrumental stems) the sum stands in for the original
 * mix, which is what the vocal-vs-mix thresholds compare against.
 */
async function rmsEnvelopeSegment(run, inputs, { offsetSec, lengthSec }) {
  const args = ['-hide_banner', '-nostats'];
  for (const input of inputs) {
    args.push('-ss', Math.max(0, offsetSec).toFixed(3), '-t', lengthSec.toFixed(3), '-i', input);
  }
  const envelope = `aresample=${VOCAL_ENVELOPE_SAMPLE_RATE},asetnsamples=n=${VOCAL_ENVELOPE_SAMPLES_PER_FRAME}:p=0,`
    + 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level';
  if (inputs.length > 1) {
    const labels = inputs.map((_, i) => `[${i}:a]`).join('');
    args.push('-filter_complex', `${labels}amix=inputs=${inputs.length}:normalize=0:duration=longest,${envelope}`);
  } else {
    args.push('-af', envelope);
  }
  args.push('-f', 'null', '-');
  const { stderr, code } = await spawnCapture(run, 'ffmpeg', args);
  return { ok: code === 0, levels: parseRmsLevels(stderr) };
}

/**
 * Vocal activity from already-separated stems (stem plan, follow-up).
 *
 * analyzeVocalActivity() runs its own Demucs pass on a 90 s head+tail clip;
 * on the realtime queue that is single-threaded and in production it hit
 * its 300 s timeout for 92% of tracks (1942/2103), which also made every
 * track's analysis take ~300 s. The stem cache already holds the head
 * (0-60 s) and tail (last 75 s) separated at DEMUCS_THREADS, which cover
 * the 30 s head / 60 s tail windows this analysis needs, so the same
 * classification can run on those files with only ffmpeg.
 *
 * Also returns the mixed-stem RMS levels of both windows (`headMixLevels`,
 * `tailMixLevels`) so the caller can rebuild phrase candidates with the
 * vocal boundaries without reading the original file again.
 * @param {object} stems getCachedStems()'s shape
 * @param {{ durationSec: number, spawnFn?: Function, headWindowSec?: number, tailWindowSec?: number }} opts
 */
export async function analyzeVocalActivityFromStems(stems, {
  durationSec,
  spawnFn = null,
  headWindowSec = HEAD_WINDOW_SEC,
  tailWindowSec = TAIL_WINDOW_SEC,
} = {}) {
  if (!stems || !(durationSec > 0)) return emptyResult();
  const run = spawnFn ?? defaultSpawn;
  const headLen = Math.min(headWindowSec, durationSec);
  const tailStart = Math.max(0, durationSec - tailWindowSec);
  const tailLen = durationSec - tailStart;
  // Levels only: a window that stops a fraction of a second short of the
  // probed duration is fine (ffmpeg just ends early).
  const lenient = { endMarginSec: -1 };
  const headWindow = findStemWindow(stems, 0, headLen, lenient);
  const tailWindow = findStemWindow(stems, tailStart, tailLen, lenient);
  if (!headWindow || !tailWindow) return emptyResult();

  const segment = (w, startSec, lengthSec) => {
    const offsetSec = startSec - w.startSec;
    return Promise.all([
      rmsEnvelopeSegment(run, [w.vocalPath], { offsetSec, lengthSec }),
      rmsEnvelopeSegment(run, [w.vocalPath, w.instrumentalPath], { offsetSec, lengthSec }),
    ]);
  };
  try {
    const [[headVocal, headMix], [tailVocal, tailMix]] = await Promise.all([
      segment(headWindow, 0, headLen),
      segment(tailWindow, tailStart, tailLen),
    ]);
    const usable = (env) => env.ok && env.levels.length > 0;
    if (![headVocal, headMix, tailVocal, tailMix].every(usable)) return emptyResult();
    const tailResult = classifyVocalEnvelope({
      vocalLevels: tailVocal.levels,
      mixLevels: tailMix.levels,
      tailStartSec: tailStart,
    });
    const headResult = classifyFirstVocalStart({
      vocalLevels: headVocal.levels,
      mixLevels: headMix.levels,
      headStartSec: 0,
    });
    return { ...tailResult, ...headResult, headMixLevels: headMix.levels, tailMixLevels: tailMix.levels };
  } catch {
    return emptyResult();
  }
}

export function defaultSpawn(cmd, args, options) {
  return spawn(cmd, args, options);
}
