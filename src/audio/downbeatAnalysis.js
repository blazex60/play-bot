import { spawnCapture } from './spawnCapture.js';
import { parseRmsLevels } from './vocalActivity.js';

/**
 * Phase 7 §6 heuristic downbeat detector: no dedicated ML backend, just a
 * low-band accent scored across candidate bar phases of the beat grid.
 * Self-contained (own ffmpeg spawn) so callers never see backend details —
 * a future dedicated detector can replace this without changing the
 * `analyzeDownbeats()` contract.
 */
export const DOWNBEAT_LOWPASS_HZ = 150;
export const DOWNBEAT_FRAME_SEC = 0.1;
export const DOWNBEAT_CONFIDENCE_MARGIN_DB = 6;
// Bias toward 4/4 (J-POP default): only switch the track-wide meter to 3
// when the 3/4 reading is clearly stronger, never on a near-tie.
export const METER3_SWITCH_RATIO = 1.25;
// astats' `reset` option is a frame count, not seconds — asetnsamples forces
// one filter-frame per DOWNBEAT_FRAME_SEC at a known rate so reset=1 actually
// means "one RMS_level print per 100ms" instead of the decoder's native
// (and unrelated) frame size.
const DOWNBEAT_SAMPLE_RATE = 44100;
const DOWNBEAT_SAMPLES_PER_FRAME = Math.round(DOWNBEAT_SAMPLE_RATE * DOWNBEAT_FRAME_SEC);

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/**
 * Score each candidate bar phase (0..meter-1) by the average low-band level
 * at beats landing on that phase, and return the winning phase plus its
 * margin over the runner-up. Pure — `levelAt` is injected so this is
 * testable without ffmpeg.
 */
export function scoreDownbeatPhase({ beatsSec, levelAt, meter = 4 }) {
  if (!Array.isArray(beatsSec) || beatsSec.length < meter || typeof levelAt !== 'function') {
    return null;
  }
  const phaseScores = [];
  for (let phase = 0; phase < meter; phase += 1) {
    let sum = 0;
    let count = 0;
    for (let i = phase; i < beatsSec.length; i += meter) {
      const level = levelAt(beatsSec[i]);
      if (Number.isFinite(level)) {
        sum += level;
        count += 1;
      }
    }
    phaseScores.push({ phase, score: count > 0 ? sum / count : -Infinity, count });
  }
  phaseScores.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = phaseScores;
  if (!Number.isFinite(best.score)) return null;
  const margin = runnerUp && Number.isFinite(runnerUp.score) ? best.score - runnerUp.score : 0;
  return { bestPhase: best.phase, margin, phaseScores };
}

function beatWindowSpan(beatsSec) {
  if (!Array.isArray(beatsSec) || beatsSec.length === 0) return null;
  const first = beatsSec[0];
  const last = beatsSec[beatsSec.length - 1];
  const interval = beatsSec.length > 1 ? (last - first) / (beatsSec.length - 1) : 1;
  const startSec = Math.max(0, first - interval);
  const lengthSec = Math.max(1, last - startSec + interval);
  return { startSec, lengthSec };
}

async function lowBandEnvelope(filePath, { startSec, lengthSec, spawnFn }) {
  // -nostats (not -loglevel error): ametadata=print has no output file and
  // writes through ffmpeg's info-level logger, so -loglevel error silently
  // discards every RMS_level line and this always returns an empty envelope.
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-nostats',
    '-ss', String(startSec),
    '-t', String(lengthSec),
    '-i', filePath,
    '-af',
    `aresample=${DOWNBEAT_SAMPLE_RATE},lowpass=f=${DOWNBEAT_LOWPASS_HZ},`
      + `asetnsamples=n=${DOWNBEAT_SAMPLES_PER_FRAME}:p=0,astats=metadata=1:reset=1,`
      + 'ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  return { ok: code === 0, levels: parseRmsLevels(stderr) };
}

function buildLevelLookup(levels, startSec, frameSec) {
  return (sec) => {
    if (!levels.length) return null;
    const idx = Math.round((sec - startSec) / frameSec);
    if (idx < 0 || idx >= levels.length) return null;
    return levels[idx];
  };
}

/** Confidence for one candidate phase, dampened by how close the competing meter's margin came. */
function candidateConfidence(chosen, competingMargin) {
  if (!chosen) return 0;
  let confidence = clamp01(chosen.margin / DOWNBEAT_CONFIDENCE_MARGIN_DB);
  if (Number.isFinite(competingMargin) && chosen.margin > 0) {
    const ambiguity = clamp01(competingMargin / chosen.margin);
    confidence *= (1 - 0.5 * ambiguity);
  }
  return confidence;
}

function emptyScore() {
  return { beatsSec: [], meter4: null, meter3: null };
}

/** Scores both meter-4 and meter-3 phase candidates for one window; does not pick a meter yet. */
async function scoreWindow(filePath, beatsSec, spawnFn) {
  const span = beatWindowSpan(beatsSec);
  if (!span || beatsSec.length < 4) return emptyScore();

  const env = await lowBandEnvelope(filePath, { ...span, spawnFn }).catch(() => ({ ok: false, levels: [] }));
  if (!env.ok || env.levels.length === 0) return emptyScore();

  const levelAt = buildLevelLookup(env.levels, span.startSec, DOWNBEAT_FRAME_SEC);
  const meter4 = scoreDownbeatPhase({ beatsSec, levelAt, meter: 4 });
  const meter3 = beatsSec.length >= 3 ? scoreDownbeatPhase({ beatsSec, levelAt, meter: 3 }) : null;
  return { beatsSec, meter4, meter3 };
}

/** Derives one window's downbeatsSec/confidence from its own scores, for the track-wide `meter`. */
function deriveWindow(scored, meter) {
  const chosen = meter === 3 ? scored.meter3 : scored.meter4;
  if (!chosen) return { downbeatsSec: [], confidence: 0 };
  const competingMargin = meter === 3 ? scored.meter4?.margin : scored.meter3?.margin;
  const confidence = candidateConfidence(chosen, competingMargin);
  const downbeatsSec = scored.beatsSec.filter((_, i) => i % meter === chosen.bestPhase);
  return { downbeatsSec, confidence };
}

/**
 * Phase 7 §6.2. `durationSec` is accepted for interface stability (a future
 * dedicated detector may want full-track context) but unused by the
 * heuristic backend, which only looks at the head/tail beat grid windows.
 */
export async function analyzeDownbeats(filePath, { durationSec = null, beatGrid, spawnFn } = {}) {
  const empty = {
    source: 'heuristic',
    meter: 4,
    head: { downbeatsSec: [] },
    tail: { downbeatsSec: [] },
    confidence: 0,
  };
  if (!filePath || !beatGrid) return empty;

  const [head, tail] = await Promise.all([
    scoreWindow(filePath, beatGrid.head?.beatsSec ?? [], spawnFn),
    scoreWindow(filePath, beatGrid.tail?.beatsSec ?? [], spawnFn),
  ]);

  // Pick ONE track-wide meter from whichever window gives the strongest,
  // least-ambiguous evidence for it — head and tail must never end up
  // filtered under different meters, or their downbeatsSec arrays would be
  // mutually inconsistent despite sharing one reported `meter`.
  const best4 = Math.max(
    candidateConfidence(head.meter4, head.meter3?.margin),
    candidateConfidence(tail.meter4, tail.meter3?.margin),
  );
  const best3 = Math.max(
    candidateConfidence(head.meter3, head.meter4?.margin),
    candidateConfidence(tail.meter3, tail.meter4?.margin),
  );
  const meter = best3 > best4 * METER3_SWITCH_RATIO ? 3 : 4;

  const headWindow = deriveWindow(head, meter);
  const tailWindow = deriveWindow(tail, meter);
  const confidence = Number((((headWindow.confidence ?? 0) + (tailWindow.confidence ?? 0)) / 2).toFixed(3));

  return {
    source: 'heuristic',
    meter,
    head: { downbeatsSec: headWindow.downbeatsSec },
    tail: { downbeatsSec: tailWindow.downbeatsSec },
    confidence,
  };
}
