import { unlink } from 'node:fs/promises';
import { BYTES_PER_SECOND } from './fade.js';
import { analyzeVocalActivity, parseRmsLevels, TAIL_WINDOW_SEC } from './vocalActivity.js';
import { analyzeKeys } from './keyAnalysis.js';
import { analyzeDownbeats } from './downbeatAnalysis.js';
import { buildBeatThisGrids } from './beatGrid.js';
import { trackBeatsWithBeatThis } from './beatThis.js';
import { buildPhraseCandidates } from './phraseAnalysis.js';
import { spawnCapture } from './spawnCapture.js';

// Bumped 3->4 for Phase 9F (§8): the tail window widened from 45s to 60s,
// so pre-existing version-3 cached payloads carry beat/phrase/vocal windows
// that stop 15s short of what this phase's analysis now covers. Without the
// bump, #getCachedAnalysis()/internal.js's `version < ANALYSIS_VERSION`
// staleness check would keep serving those narrower cached windows forever,
// silently defeating the widened search range for every already-analyzed
// track (Codex review, PR #52).
// v5: vocal activity now comes from the stem cache after separation
// (applyVocalActivity) instead of a single-threaded Demucs pass that timed
// out for most v4 rows; bumping re-analyzes those (and v4 rows stuck with
// bpm: null) the next time each track is played.
// v6: beats and downbeats come from Beat This! (whole track, GPU) when it is
// available; aubio + the low-band downbeat heuristic remain the fallback.
// isReusableAnalysis() keeps v5 rows while Beat This! is unavailable.
export const ANALYSIS_VERSION = 6;
// Oldest version the internal API still hands to the bot. v5 differs from v6
// only in the beat tracker, so isReusableAnalysis() decides per host whether
// to keep it (no GPU) or re-analyze it (Beat This! available).
export const MIN_SERVED_ANALYSIS_VERSION = 5;
// Phase 7 §9.2 prefers entry points in the first 0-30s of the incoming
// track; keep the BPM window and the vocal head window (vocalActivity.js
// HEAD_WINDOW_SEC) the same length so beatGrid/vocal boundaries line up.
export const HEAD_BPM_WINDOW_SEC = 30;
// Derived from vocalActivity.js's TAIL_WINDOW_SEC (not a separately-tracked
// duplicate): beatGrid.tail / phrases.tail (the pool findExitCandidates()
// searches — see beatmixTransition.js) must reach exactly as far back as
// vocal.lastVocalEndSec/vocalGaps do, or Phase 9F's widened tail window
// (§8) would relax the vocal-safety floor's coverage without actually
// growing the exit-candidate pool it gates, silently missing the phase's
// completion criterion (a phrase boundary before the old 45s bound must
// become selectable as exit).
export const TAIL_BPM_WINDOW_SEC = TAIL_WINDOW_SEC;
export const PHRASE_FEATURE_FRAME_SEC = 0.1;
// astats' `reset` option is a frame count, not seconds — asetnsamples forces
// one filter-frame per PHRASE_FEATURE_FRAME_SEC at a known rate so reset=1
// actually means "one RMS_level print per 100ms" (see downbeatAnalysis.js).
const PHRASE_FEATURE_SAMPLE_RATE = 44100;
const PHRASE_FEATURE_SAMPLES_PER_FRAME = Math.round(PHRASE_FEATURE_SAMPLE_RATE * PHRASE_FEATURE_FRAME_SEC);

/**
 * `role` (e.g. 'head'/'tail') must be included: for tracks between
 * HEAD_BPM_WINDOW_SEC and TAIL_BPM_WINDOW_SEC in length, the head and tail
 * windows can resolve to the same startSec/windowSec, and the two parallel
 * analyzeBpmWindow() calls would otherwise write/read/unlink the same file.
 */
export function bpmTempPath(filePath, startSec, windowSec, role = '') {
  const startMs = Math.round(Math.max(0, startSec) * 1000);
  const windowMs = Math.round(Math.max(0, windowSec) * 1000);
  const roleSuffix = role ? `.${role}` : '';
  return `${filePath}.bpm${roleSuffix}.${startMs}.${windowMs}.wav`;
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
export async function analyzeBpmWindow(filePath, { startSec, windowSec, spawnFn, role = '' }) {
  const which = await spawnCapture(spawnFn, 'bash', ['-lc', 'command -v aubiotrack || true']);
  if (!which.stdout.trim()) {
    return { available: false, bpm: null, confidence: 0, firstBeatSec: null, beatCount: 0, beatsSec: [] };
  }
  const wavPath = bpmTempPath(filePath, startSec, windowSec, role);
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
    // Number('') === 0 (finite), not NaN — an empty aubiotrack stdout (zero
    // beats detected) would otherwise fabricate a single beat at time 0.
    const beats = stdout.trim().split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));
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
  // -nostats (not -loglevel error): see lowBandEnvelope() in downbeatAnalysis.js
  // for why -loglevel error silently empties the RMS_level stream.
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-nostats',
    '-ss', String(Math.max(0, startSec)),
    '-t', String(windowSec),
    '-i', filePath,
    '-af',
    `aresample=${PHRASE_FEATURE_SAMPLE_RATE},asetnsamples=n=${PHRASE_FEATURE_SAMPLES_PER_FRAME}:p=0,`
      + 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
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

/** Exported for direct unit testing; also used internally to clamp bpmConfidence/beatConfidence. */
export function isHalfDouble(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  const ratio = a > b ? a / b : b / a;
  return ratio > 1.8 && ratio < 2.2;
}

/** Shared clamp applied to both bpmConfidence and beatConfidence when head/tail disagree by ~2x. */
export function dampIfHalfDouble(confidence, headBpm, tailBpm) {
  return isHalfDouble(headBpm, tailBpm) ? Math.min(confidence, 0.35) : confidence;
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

function noVocalResult() {
  return {
    ok: false, lastVocalEndSec: null, vocalGaps: [], vocalConfidence: 0, source: 'none',
    firstVocalStartSec: null, headVocalGaps: [],
  };
}

const VOCAL_CONFIDENCE_WEIGHT = 0.5;

function compositeConfidence({ vocalConfidence, bpmConfidence, tailOk }) {
  const vocal = vocalConfidence ?? 0;
  const bpm = bpmConfidence ?? 0;
  const tail = tailOk ? 0.8 : 0.3;
  return Number(((vocal * VOCAL_CONFIDENCE_WEIGHT) + (bpm * 0.3) + (tail * 0.2)).toFixed(3));
}

function buildPhrases({ downbeatGrid, durationSec, headLevels, tailLevels, vocal }) {
  const tailStart = Math.max(0, durationSec - TAIL_BPM_WINDOW_SEC);
  return {
    head: buildPhraseCandidates({
      downbeatsSec: downbeatGrid?.head?.downbeatsSec ?? [],
      features: { frameSec: PHRASE_FEATURE_FRAME_SEC, startSec: 0, rmsLevels: headLevels ?? [] },
      vocalActivity: { boundariesSec: collectBoundaries(vocal.firstVocalStartSec, vocal.headVocalGaps) },
    }),
    tail: buildPhraseCandidates({
      downbeatsSec: downbeatGrid?.tail?.downbeatsSec ?? [],
      features: { frameSec: PHRASE_FEATURE_FRAME_SEC, startSec: tailStart, rmsLevels: tailLevels ?? [] },
      vocalActivity: { boundariesSec: collectBoundaries(vocal.lastVocalEndSec, vocal.vocalGaps) },
    }),
  };
}

/**
 * Fill a deferred (or failed) analysis' vocal fields from a later vocal
 * result — analyzeVocalActivityFromStems(), run once the stems exist.
 * Rebuilds what depends on vocal activity: the phrase candidates (vocal
 * boundaries; RMS features come from the result's mixed-stem levels, the
 * same 30 s head / 60 s tail windows at the same 100 ms frame as
 * measureRmsEnvelope()) and the composite confidence, whose other terms
 * are unchanged so only the vocal term is swapped.
 * @returns {object} a new analysis object; the input is not mutated
 */
export function applyVocalActivity(analysis, vocal) {
  if (!analysis || !vocal?.ok) return analysis;
  const vocalConfidence = vocal.vocalConfidence ?? 0;
  const confidence = Number((
    (analysis.confidence ?? 0) + (vocalConfidence - (analysis.vocalConfidence ?? 0)) * VOCAL_CONFIDENCE_WEIGHT
  ).toFixed(3));
  const hasLevels = Array.isArray(vocal.headMixLevels) && Array.isArray(vocal.tailMixLevels);
  return {
    ...analysis,
    vocalConfidence,
    lastVocalEndSec: vocal.lastVocalEndSec ?? null,
    vocalGaps: vocal.vocalGaps ?? [],
    firstVocalStartSec: vocal.firstVocalStartSec ?? null,
    headVocalGaps: vocal.headVocalGaps ?? [],
    analysisSource: vocal.source ?? 'demucs',
    phrases: hasLevels
      ? buildPhrases({
        downbeatGrid: analysis.downbeatGrid,
        durationSec: analysis.durationSec,
        headLevels: vocal.headMixLevels,
        tailLevels: vocal.tailMixLevels,
        vocal,
      })
      : analysis.phrases,
    confidence,
    vocalAnalyzedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Analyze a downloaded audio file for MIX transitions.
 * Pass `spawnFn` from the analysis queue so underrun SIGSTOP covers ffmpeg/aubio.
 * Phase 7A adds beat grid / downbeat / phrase / head-vocal metadata on top of
 * the Phase 6 payload; it does not change playback (transition.js, MixStream,
 * player.js are untouched by this file).
 */
export async function analyzeTrackFile(filePath, {
  videoId = null,
  durationSec = null,
  spawnFn,
  signal = null,
  // 'demucs' runs analyzeVocalActivity()'s own Demucs pass (the original
  // behavior). 'deferred' skips it and returns analysisSource: 'none'; the
  // caller fills vocal fields in later via applyVocalActivity() once stems
  // exist. hasVocalAnalysis() treats 'none' as "not verified", so a deferred
  // analysis is never mistaken for a vocal-safe one in the meantime.
  vocalActivity: vocalMode = 'demucs',
  // Whole-track beats/downbeats from Beat This! (null when it is not in use
  // or failed); aubio's head/tail windows are the fallback.
  beatTrackerFn = trackBeatsWithBeatThis,
} = {}) {
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

  const [tail, headBpmAubio, tailBpmAubio, vocal, keys, tracked] = await Promise.all([
    analyzeTailShape(filePath, duration, spawnFn),
    analyzeBpmWindow(filePath, { startSec: 0, windowSec: headWindow, spawnFn, role: 'head' })
      .catch(() => ({ available: false, bpm: null, confidence: 0, firstBeatSec: null, beatsSec: [] })),
    analyzeBpmWindow(filePath, { startSec: tailStart, windowSec: tailWindow, spawnFn, role: 'tail' })
      .catch(() => ({ available: false, bpm: null, confidence: 0, firstBeatSec: null, beatsSec: [] })),
    (vocalMode === 'deferred'
      ? Promise.resolve(noVocalResult())
      : analyzeVocalActivity(filePath, { durationSec: duration, spawnFn }).catch(() => noVocalResult())),
    analyzeKeys(filePath, duration, { spawnFn })
      .catch(() => ({ headKey: null, tailKey: null, harmonicConfidence: 0 })),
    Promise.resolve(beatTrackerFn ? beatTrackerFn(filePath) : null).catch(() => null),
  ]);
  throwIfAborted(signal);

  const beatThis = tracked?.beatsSec?.length
    ? buildBeatThisGrids(tracked, { headWindowSec: headWindow, tailStartSec: tailStart, tailWindowSec: tailWindow })
    : null;
  const fromGrid = (grid, fallback) => (grid
    ? { bpm: grid.bpm, confidence: 0.6, firstBeatSec: grid.beatsSec[0] ?? null, beatsSec: grid.beatsSec }
    : fallback);
  // A window Beat This! could not grid (e.g. a beatless intro) stays empty
  // rather than borrowing aubio's BPM, so the BPM always matches beatGrid.
  const noGrid = { bpm: null, confidence: 0, firstBeatSec: null, beatsSec: [] };
  const headBpm = beatThis ? fromGrid(beatThis.head, noGrid) : headBpmAubio;
  const tailBpm = beatThis ? fromGrid(beatThis.tail, noGrid) : tailBpmAubio;

  const overlapSec = recommendOverlapSec(tail.shape, duration);
  const bpm = tailBpm.bpm ?? headBpm.bpm ?? null;
  const bpmConfidence = dampIfHalfDouble(
    tailBpm.confidence || headBpm.confidence || 0,
    headBpm.bpm,
    tailBpm.bpm,
  );
  const vocalConfidence = vocal.vocalConfidence ?? 0;
  const harmonicConfidence = keys.harmonicConfidence ?? 0;

  const beatGrid = beatThis?.beatGrid ?? {
    source: 'aubio',
    head: { startSec: 0, beatsSec: headBpm.beatsSec ?? [] },
    tail: { startSec: tailStart, beatsSec: tailBpm.beatsSec ?? [] },
  };
  // Beat This!: how well the detected beats sit on the fitted grid. aubio:
  // interval regularity + coverage (its grid is not fitted).
  const headBeatConfidence = beatThis ? (beatThis.head?.confidence ?? 0) : beatGridConfidence(beatGrid.head.beatsSec, headWindow);
  const tailBeatConfidence = beatThis ? (beatThis.tail?.confidence ?? 0) : beatGridConfidence(beatGrid.tail.beatsSec, tailWindow);
  // Both windows can independently report a tight, regular grid while
  // describing different (half/double-related) tempos — that's not a
  // trustworthy beat grid for tempo sync, so dampen it the same way
  // bpmConfidence already is.
  const beatConfidence = dampIfHalfDouble(
    Number((((headBeatConfidence + tailBeatConfidence) / 2)).toFixed(3)),
    headBpm.bpm,
    tailBpm.bpm,
  );

  const [downbeatGrid, headFeatures, tailFeatures] = await Promise.all([
    (beatThis
      ? Promise.resolve(beatThis.downbeatGrid)
      : analyzeDownbeats(filePath, { durationSec: duration, beatGrid, spawnFn })
        .catch(() => ({ source: 'heuristic', meter: 4, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] }, confidence: 0 }))),
    measureRmsEnvelope(filePath, { startSec: 0, windowSec: headWindow, spawnFn })
      .catch(() => ({ ok: false, levels: [] })),
    measureRmsEnvelope(filePath, { startSec: tailStart, windowSec: tailWindow, spawnFn })
      .catch(() => ({ ok: false, levels: [] })),
  ]);
  throwIfAborted(signal);

  const phrases = buildPhrases({
    downbeatGrid,
    durationSec: duration,
    headLevels: headFeatures.levels,
    tailLevels: tailFeatures.levels,
    vocal,
  });

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
    beatSource: beatGrid.source,
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
