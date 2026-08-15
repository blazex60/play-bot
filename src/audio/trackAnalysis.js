import { unlink } from 'node:fs/promises';
import { BYTES_PER_SECOND } from './fade.js';
import { analyzeVocalActivity, parseRmsLevels } from './vocalActivity.js';
import { analyzeKeys } from './keyAnalysis.js';
import { analyzeDownbeats } from './downbeatAnalysis.js';
import { buildPhraseCandidates } from './phraseAnalysis.js';
import { spawnCapture } from './spawnCapture.js';

export const ANALYSIS_VERSION = 3;
// Phase 7 §9.2 prefers entry points in the first 0-30s of the incoming
// track; keep the BPM window and the vocal head window (vocalActivity.js
// HEAD_WINDOW_SEC) the same length so beatGrid/vocal boundaries line up.
export const HEAD_BPM_WINDOW_SEC = 30;
export const TAIL_BPM_WINDOW_SEC = 45;
export const PHRASE_FEATURE_FRAME_SEC = 0.1;

export function bpmTempPath(filePath, startSec, windowSec) {
  const startMs = Math.round(Math.max(0, startSec) * 1000);
  const windowMs = Math.round(Math.max(0, windowSec) * 1000);
  return `${filePath}.bpm.${startMs}.${windowMs}.wav`;
}

function analysisAbortedError() {
  const err = new Error('analysis aborted');
  err.code = 'ANALYSIS_KILLED';
  return err;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw analysisAbortedError();
}

function quantizeSec(sec) {
  return Math.round(sec * 1000) / 1000;
}

async function analyzeTailShape(filePath, durationSec, spawnFn) {
  const tail = Math.min(30, Math.max(5, durationSec * 0.25));
  const start = Math.max(0, durationSec - tail);
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-nostats',
    '-ss', String(start),
    '-i', filePath,
    '-af',
    'silencedetect=noise=-40dB:d=0.3,astats=metadata=1:reset=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  const levels = [...stderr.matchAll(/RMS_level=([-0-9.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const silenceStarts = [...stderr.matchAll(/silence_start:\s*([-0-9.]+)/g)].map((m) => Number(m[1]));

  let shape = 'unknown';
  if (levels.length >= 5) {
    const head = average(levels.slice(0, Math.floor(levels.length * 0.3)));
    const end = average(levels.slice(-Math.floor(levels.length * 0.2)));
    const drop = head - end;
    if (end < -45 || silenceStarts.length > 0) shape = 'silence-tail';
    else if (drop > 12) shape = 'fade-out';
    else if (Math.abs(drop) < 4) shape = 'abrupt';
    else shape = 'gentle-decay';
  }

  return {
    ok: code === 0 && levels.length > 0,
    shape,
    lastRms: levels.at(-1) ?? null,
    silenceCount: silenceStarts.length,
  };
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function beatsToBpm(beats) {
  if (beats.length < 4) return { bpm: null, firstBeatSec: null };
  const intervals = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)];
  const bpm = median > 0 ? Number((60 / median).toFixed(2)) : null;
  return { bpm, firstBeatSec: beats[0] ?? null };
}

/**
 * Phase 7 §5: absolute-time beat grid consistency. Lower relative MAD
 * (tight, regular intervals) and higher coverage (few missed beats within
 * the window) both raise confidence. Independent of `bpmConfidence`, which
 * stays the pre-Phase-7 constant (0.6/0) so existing crossfade branching in
 * transition.js is untouched.
 */
export function beatGridConfidence(beatsSec, windowSec = null) {
  if (!Array.isArray(beatsSec) || beatsSec.length < 4) return 0;
  const intervals = [];
  for (let i = 1; i < beatsSec.length; i += 1) intervals.push(beatsSec[i] - beatsSec[i - 1]);
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return 0;
  const mad = intervals.reduce((sum, iv) => sum + Math.abs(iv - median), 0) / intervals.length;
  const relMad = mad / median;
  const consistency = Math.max(0, Math.min(1, 1 - relMad / 0.15));
  let coverage = 1;
  if (windowSec > 0) {
    const expectedBeats = windowSec / median;
    coverage = expectedBeats > 0 ? Math.max(0, Math.min(1, beatsSec.length / expectedBeats)) : 1;
  }
  return Number(Math.max(0, Math.min(1, consistency * 0.7 + coverage * 0.3)).toFixed(3));
}

/** Exported for direct fixture testing (trackAnalysis.test.js) without pulling in Demucs/essentia. */
export async function analyzeBpmWindow(filePath, { startSec, windowSec, spawnFn }) {
  const which = await spawnCapture(spawnFn, 'bash', ['-lc', 'command -v aubiotrack || true']);
  if (!which.stdout.trim()) {
    return { available: false, bpm: null, confidence: 0, firstBeatSec: null, beatCount: 0, beatsSec: [] };
  }
  const wavPath = bpmTempPath(filePath, startSec, windowSec);
  try {
    const conv = await spawnCapture(spawnFn, 'ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, startSec)),
      '-t', String(windowSec),
      '-i', filePath,
      '-ac', '1', '-ar', '44100', wavPath,
    ]);
    if (conv.code !== 0) {
      return { available: true, ok: false, bpm: null, beatCount: 0, confidence: 0, firstBeatSec: null, beatsSec: [] };
    }
    const { stdout, code } = await spawnCapture(spawnFn, 'aubiotrack', ['-i', wavPath]);
    const beats = stdout.trim().split('\n').map(Number).filter((n) => Number.isFinite(n));
    const { bpm, firstBeatSec } = beatsToBpm(beats);
    const absFirst = firstBeatSec != null ? startSec + firstBeatSec : null;
    // Phase 7 §5: keep the timestamps instead of collapsing them into the
    // median-interval BPM — the beat grid is now a first-class payload field.
    const beatsSec = beats.map((b) => quantizeSec(startSec + b));
    return {
      available: true,
      ok: code === 0 && bpm != null,
      bpm,
      beatCount: beats.length,
      firstBeatSec: absFirst,
      confidence: bpm != null ? 0.6 : 0,
      beatsSec,
    };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

async function measureRmsEnvelope(filePath, { startSec, windowSec, spawnFn }) {
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(Math.max(0, startSec)),
    '-t', String(windowSec),
    '-i', filePath,
    '-af', 'astats=metadata=1:reset=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  return { ok: code === 0, levels: parseRmsLevels(stderr) };
}

function collectBoundaries(...values) {
  const out = [];
  for (const v of values) {
    if (Array.isArray(v)) {
      for (const g of v) {
        if (Number.isFinite(g?.startSec)) out.push(g.startSec);
        if (Number.isFinite(g?.endSec)) out.push(g.endSec);
      }
    } else if (Number.isFinite(v)) {
      out.push(v);
    }
  }
  return out;
}

/** Exported for direct unit testing; also used internally to clamp bpmConfidence. */
export function isHalfDouble(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  const ratio = a > b ? a / b : b / a;
  return ratio > 1.8 && ratio < 2.2;
}

/**
 * Recommend overlap seconds from tail shape. Vocal window is applied in transition.js.
 */
export function recommendOverlapSec(shape, durationSec) {
  let sec;
  switch (shape) {
    case 'fade-out':
      sec = 1.5;
      break;
    case 'gentle-decay':
      sec = 2.5;
      break;
    case 'silence-tail':
      sec = 3;
      break;
    case 'abrupt':
      sec = 5;
      break;
    default:
      sec = 2;
  }
  const cap = Math.max(1, durationSec * 0.1);
  return Math.min(sec, cap);
}

function compositeConfidence({ vocalConfidence, bpmConfidence, tailOk }) {
  const vocal = vocalConfidence ?? 0;
  const bpm = bpmConfidence ?? 0;
  const tail = tailOk ? 0.8 : 0.3;
  return Number(((vocal * 0.5) + (bpm * 0.3) + (tail * 0.2)).toFixed(3));
}

/**
 * Analyze a downloaded audio file for MIX transitions.
 * Pass `spawnFn` from the analysis queue so underrun SIGSTOP covers ffmpeg/aubio.
 * Phase 7A adds beat grid / downbeat / phrase / head-vocal metadata on top of
 * the Phase 6 payload; it does not change playback (transition.js, MixStream,
 * player.js are untouched by this file).
 */
export async function analyzeTrackFile(filePath, { videoId = null, durationSec = null, spawnFn, signal = null } = {}) {
  throwIfAborted(signal);
  let duration = durationSec;
  if (duration == null || !Number.isFinite(duration)) {
    const { stdout } = await spawnCapture(spawnFn, 'ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    duration = Number(stdout.trim());
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('unable to determine track duration for analysis');
  }
  throwIfAborted(signal);

  const tailStart = Math.max(0, duration - TAIL_BPM_WINDOW_SEC);
  const headWindow = Math.min(HEAD_BPM_WINDOW_SEC, duration);
  const tailWindow = Math.min(TAIL_BPM_WINDOW_SEC, duration);

  const [tail, headBpm, tailBpm, vocal, keys] = await Promise.all([
    analyzeTailShape(filePath, duration, spawnFn),
    analyzeBpmWindow(filePath, { startSec: 0, windowSec: headWindow, spawnFn })
      .catch(() => ({ available: false, bpm: null, confidence: 0, firstBeatSec: null, beatsSec: [] })),
    analyzeBpmWindow(filePath, { startSec: tailStart, windowSec: tailWindow, spawnFn })
      .catch(() => ({ available: false, bpm: null, confidence: 0, firstBeatSec: null, beatsSec: [] })),
    analyzeVocalActivity(filePath, { durationSec: duration, spawnFn })
      .catch(() => ({
        ok: false, lastVocalEndSec: null, vocalGaps: [], vocalConfidence: 0, source: 'none',
        firstVocalStartSec: null, headVocalGaps: [],
      })),
    analyzeKeys(filePath, duration, { spawnFn })
      .catch(() => ({ headKey: null, tailKey: null, harmonicConfidence: 0 })),
  ]);
  throwIfAborted(signal);

  const overlapSec = recommendOverlapSec(tail.shape, duration);
  const bpm = tailBpm.bpm ?? headBpm.bpm ?? null;
  let bpmConfidence = tailBpm.confidence || headBpm.confidence || 0;
  if (isHalfDouble(headBpm.bpm, tailBpm.bpm)) {
    bpmConfidence = Math.min(bpmConfidence, 0.35);
  }
  const vocalConfidence = vocal.vocalConfidence ?? 0;
  const harmonicConfidence = keys.harmonicConfidence ?? 0;

  const beatGrid = {
    source: 'aubio',
    head: { startSec: 0, beatsSec: headBpm.beatsSec ?? [] },
    tail: { startSec: tailStart, beatsSec: tailBpm.beatsSec ?? [] },
  };
  const headBeatConfidence = beatGridConfidence(beatGrid.head.beatsSec, headWindow);
  const tailBeatConfidence = beatGridConfidence(beatGrid.tail.beatsSec, tailWindow);
  const beatConfidence = Number((((headBeatConfidence + tailBeatConfidence) / 2)).toFixed(3));

  const [downbeatGrid, headFeatures, tailFeatures] = await Promise.all([
    analyzeDownbeats(filePath, { durationSec: duration, beatGrid, spawnFn })
      .catch(() => ({ source: 'heuristic', meter: 4, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] }, confidence: 0 })),
    measureRmsEnvelope(filePath, { startSec: 0, windowSec: headWindow, spawnFn })
      .catch(() => ({ ok: false, levels: [] })),
    measureRmsEnvelope(filePath, { startSec: tailStart, windowSec: tailWindow, spawnFn })
      .catch(() => ({ ok: false, levels: [] })),
  ]);
  throwIfAborted(signal);

  const phrases = {
    head: buildPhraseCandidates({
      downbeatsSec: downbeatGrid.head?.downbeatsSec ?? [],
      features: { frameSec: PHRASE_FEATURE_FRAME_SEC, startSec: 0, rmsLevels: headFeatures.levels ?? [] },
      vocalActivity: { boundariesSec: collectBoundaries(vocal.firstVocalStartSec, vocal.headVocalGaps) },
    }),
    tail: buildPhraseCandidates({
      downbeatsSec: downbeatGrid.tail?.downbeatsSec ?? [],
      features: { frameSec: PHRASE_FEATURE_FRAME_SEC, startSec: tailStart, rmsLevels: tailFeatures.levels ?? [] },
      vocalActivity: { boundariesSec: collectBoundaries(vocal.lastVocalEndSec, vocal.vocalGaps) },
    }),
  };

  return {
    version: ANALYSIS_VERSION,
    videoId,
    durationSec: duration,
    tailShape: tail.shape,
    lastRms: tail.lastRms,
    bpm,
    bpmConfidence,
    beatConfidence,
    headBpm: headBpm.bpm ?? null,
    tailBpm: tailBpm.bpm ?? null,
    headBeatOffsetSec: headBpm.firstBeatSec ?? 0,
    tailBeatOffsetSec: tailBpm.firstBeatSec ?? null,
    beatGrid,
    downbeatGrid,
    phrases,
    headKey: keys.headKey ?? null,
    tailKey: keys.tailKey ?? null,
    harmonicConfidence,
    vocalConfidence,
    lastVocalEndSec: vocal.lastVocalEndSec ?? null,
    vocalGaps: vocal.vocalGaps ?? [],
    firstVocalStartSec: vocal.firstVocalStartSec ?? null,
    headVocalGaps: vocal.headVocalGaps ?? [],
    analysisSource: vocal.source ?? 'none',
    recommendedOverlapSec: overlapSec,
    confidence: compositeConfidence({
      vocalConfidence,
      bpmConfidence,
      tailOk: tail.ok,
    }),
    analyzedAt: Math.floor(Date.now() / 1000),
  };
}

export function bytesForSeconds(sec) {
  return Math.round(sec * BYTES_PER_SECOND);
}
