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
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(startSec),
    '-t', String(lengthSec),
    '-i', filePath,
    '-af',
    `lowpass=f=${DOWNBEAT_LOWPASS_HZ},astats=metadata=1:reset=${DOWNBEAT_FRAME_SEC},ametadata=print:key=lavfi.astats.Overall.RMS_level`,
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

const EMPTY_WINDOW = { downbeatsSec: [], meter: 4, confidence: 0 };

async function analyzeWindow(filePath, beatsSec, spawnFn) {
  const span = beatWindowSpan(beatsSec);
  if (!span || beatsSec.length < 4) return EMPTY_WINDOW;

  const env = await lowBandEnvelope(filePath, { ...span, spawnFn }).catch(() => ({ ok: false, levels: [] }));
  if (!env.ok || env.levels.length === 0) return EMPTY_WINDOW;

  const levelAt = buildLevelLookup(env.levels, span.startSec, DOWNBEAT_FRAME_SEC);
  const meter4 = scoreDownbeatPhase({ beatsSec, levelAt, meter: 4 });
  if (!meter4) return EMPTY_WINDOW;
  const meter3 = beatsSec.length >= 3 ? scoreDownbeatPhase({ beatsSec, levelAt, meter: 3 }) : null;

  // Bias toward 4/4 (J-POP default): only switch to 3 when its margin is
  // clearly stronger, never on a near-tie.
  let meter = 4;
  let chosen = meter4;
  if (meter3 && meter3.margin > meter4.margin) {
    meter = 3;
    chosen = meter3;
  }

  let confidence = clamp01(chosen.margin / DOWNBEAT_CONFIDENCE_MARGIN_DB);
  const competingMargin = meter === 4 ? meter3?.margin : meter4.margin;
  if (Number.isFinite(competingMargin) && chosen.margin > 0) {
    // 4/4 vs 3/4 near-tie: never claim a confident meter guess.
    const ambiguity = clamp01(competingMargin / chosen.margin);
    confidence *= (1 - 0.5 * ambiguity);
  }

  const downbeatsSec = beatsSec.filter((_, i) => i % meter === chosen.bestPhase);
  return { downbeatsSec, meter, confidence: Number(confidence.toFixed(3)) };
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
    analyzeWindow(filePath, beatGrid.head?.beatsSec ?? [], spawnFn),
    analyzeWindow(filePath, beatGrid.tail?.beatsSec ?? [], spawnFn),
  ]);

  const meter = (head.confidence ?? 0) >= (tail.confidence ?? 0) ? head.meter : tail.meter;
  const confidence = Number((((head.confidence ?? 0) + (tail.confidence ?? 0)) / 2).toFixed(3));

  return {
    source: 'heuristic',
    meter,
    head: { downbeatsSec: head.downbeatsSec },
    tail: { downbeatsSec: tail.downbeatsSec },
    confidence,
  };
}
