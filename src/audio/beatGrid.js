/**
 * Turn Beat This! output (whole-track beat and downbeat times) into the
 * analysis payload's head/tail beat and downbeat grids
 * (.omc/plans/beat-this-integration.md).
 *
 * Beat This! is far more accurate than aubio on production tracks, but its
 * times are quantized to 20 ms frames and it occasionally adds a stray beat.
 * So each window gets an evenly spaced grid fitted to the detected beats;
 * beats off that grid are dropped, and the confidence says how well the
 * detected beats agree with it.
 */

// Beat This! frames are 20 ms; ±35 ms keeps an on-grid beat even with that
// quantization, while a stray off-beat (≥ 1/4 beat away at 200 BPM = 75 ms)
// falls outside.
export const GRID_TOLERANCE_SEC = 0.035;
// A detected downbeat may sit up to this far from its grid slot.
export const DOWNBEAT_TOLERANCE_SEC = 0.07;
const MIN_BEATS = 8;
const MIN_DOWNBEATS = 3;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return { value: best, count: bestCount };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** Least-squares line b = t0 + k * period over (k, b) pairs. */
function regress(points) {
  const n = points.length;
  let sk = 0; let sb = 0; let skk = 0; let skb = 0;
  for (const [k, b] of points) {
    sk += k; sb += b; skk += k * k; skb += k * b;
  }
  const denom = n * skk - sk * sk;
  if (denom === 0) return null;
  const period = (n * skb - sk * sb) / denom;
  return { period, t0: (sb - period * sk) / n };
}

/**
 * Fit an evenly spaced beat grid to the detected beats inside
 * [startSec, endSec). Returns null when there are too few beats.
 * @returns {{ periodSec: number, bpm: number, t0: number, kMin: number, kMax: number,
 *   beatsSec: number[], confidence: number, inliers: number, detected: number } | null}
 */
export function fitBeatGrid(beatsSec, { startSec, endSec, toleranceSec = GRID_TOLERANCE_SEC } = {}) {
  const beats = (beatsSec ?? []).filter((b) => b >= startSec && b < endSec);
  if (beats.length < MIN_BEATS) return null;
  const diffs = [];
  for (let i = 1; i < beats.length; i += 1) diffs.push(beats[i] - beats[i - 1]);
  // 20 ms quantization makes the intervals alternate (128 BPM: 0.46/0.48 s),
  // so the median alone is off by ~2%; averaging the intervals near it
  // recovers the true period (stray/missed beats fall outside ±15%).
  const med = median(diffs);
  if (!(med > 0)) return null;
  const near = diffs.filter((d) => Math.abs(d / med - 1) <= 0.15);
  let period = near.reduce((a, b) => a + b, 0) / near.length;

  // Anchor by circular mean of the beat phases, so one stray first beat does
  // not shift the whole grid.
  let sx = 0; let sy = 0;
  for (const b of beats) {
    const a = (2 * Math.PI * b) / period;
    sx += Math.cos(a); sy += Math.sin(a);
  }
  let t0 = ((Math.atan2(sy, sx) / (2 * Math.PI)) * period);

  let inliers = [];
  // First pass with a loose tolerance (the median period can be slightly
  // off, which drifts over a 60 s window), then tighten.
  for (const tol of [period * 0.25, toleranceSec * 2, toleranceSec, toleranceSec]) {
    const points = [];
    for (const b of beats) {
      const k = Math.round((b - t0) / period);
      if (Math.abs(b - (t0 + k * period)) <= tol) points.push([k, b]);
    }
    // Two detections on the same slot: keep the closer one.
    const bySlot = new Map();
    for (const [k, b] of points) {
      const prev = bySlot.get(k);
      if (prev == null || Math.abs(b - (t0 + k * period)) < Math.abs(prev - (t0 + k * period))) bySlot.set(k, b);
    }
    inliers = [...bySlot.entries()].sort((a, b) => a[0] - b[0]);
    if (inliers.length < MIN_BEATS) return null;
    const fit = regress(inliers);
    if (!fit || !(fit.period > 0)) return null;
    ({ period, t0 } = fit);
  }

  const kMin = inliers[0][0];
  const kMax = inliers[inliers.length - 1][0];
  const slots = kMax - kMin + 1;
  const gridBeats = [];
  for (let k = kMin; k <= kMax; k += 1) {
    const t = t0 + k * period;
    if (t >= startSec && t < endSec) gridBeats.push(round3(t));
  }
  // precision: share of detected beats on the grid (stray beats lower it).
  // fill: share of grid slots that had a detection (missed beats lower it).
  // span: a grid covering under half the window says little about the rest.
  const precision = inliers.length / beats.length;
  const fill = inliers.length / slots;
  const spanRatio = ((kMax - kMin) * period) / Math.max(1e-9, endSec - startSec);
  const confidence = precision * fill * Math.min(1, spanRatio / 0.5);
  return {
    periodSec: period,
    bpm: Number((60 / period).toFixed(2)),
    t0,
    kMin,
    kMax,
    beatsSec: gridBeats,
    confidence: Number(Math.max(0, Math.min(1, confidence)).toFixed(3)),
    inliers: inliers.length,
    detected: beats.length,
  };
}

/** 3 when bars between Beat This! downbeats mostly hold 3 beats, else 4. */
export function estimateMeter(beatsSec, downbeatsSec) {
  const counts = [];
  for (let i = 1; i < (downbeatsSec?.length ?? 0); i += 1) {
    const a = downbeatsSec[i - 1] - 0.02;
    const b = downbeatsSec[i] - 0.02;
    counts.push(beatsSec.filter((t) => t >= a && t < b).length);
  }
  return mode(counts).value === 3 ? 3 : 4;
}

/**
 * Place downbeats on a fitted grid: snap each detected downbeat to its slot,
 * take the most common bar phase, and emit every `meter`-th slot from it.
 */
export function deriveDownbeats(grid, downbeatsSec, { meter = 4, toleranceSec = DOWNBEAT_TOLERANCE_SEC } = {}) {
  if (!grid) return { downbeatsSec: [], confidence: 0 };
  const slots = [];
  for (const d of downbeatsSec ?? []) {
    const k = Math.round((d - grid.t0) / grid.periodSec);
    if (k < grid.kMin || k > grid.kMax) continue;
    if (Math.abs(d - (grid.t0 + k * grid.periodSec)) <= toleranceSec) slots.push(k);
  }
  if (slots.length < MIN_DOWNBEATS) return { downbeatsSec: [], confidence: 0 };
  const phaseOf = (k) => ((k % meter) + meter) % meter;
  const { value: phase, count } = mode(slots.map(phaseOf));
  const expectedBars = Math.max(slots.length, Math.floor((grid.kMax - grid.kMin + 1) / meter));
  const downbeats = [];
  for (let k = grid.kMin; k <= grid.kMax; k += 1) {
    if (phaseOf(k) === phase) downbeats.push(round3(grid.t0 + k * grid.periodSec));
  }
  return { downbeatsSec: downbeats, confidence: Number((count / expectedBars).toFixed(3)) };
}

/**
 * Build the analysis fields from one Beat This! run over the whole track.
 * Returns null when neither window yields a grid (caller falls back to aubio).
 */
export function buildBeatThisGrids({ beatsSec, downbeatsSec }, { headWindowSec, tailStartSec, tailWindowSec }) {
  const head = fitBeatGrid(beatsSec, { startSec: 0, endSec: headWindowSec });
  const tail = fitBeatGrid(beatsSec, { startSec: tailStartSec, endSec: tailStartSec + tailWindowSec });
  if (!head && !tail) return null;
  const meter = estimateMeter(beatsSec, downbeatsSec);
  const headDown = deriveDownbeats(head, downbeatsSec, { meter });
  const tailDown = deriveDownbeats(tail, downbeatsSec, { meter });
  return {
    head,
    tail,
    beatGrid: {
      source: 'beat_this',
      head: { startSec: 0, beatsSec: head?.beatsSec ?? [] },
      tail: { startSec: tailStartSec, beatsSec: tail?.beatsSec ?? [] },
    },
    downbeatGrid: {
      source: 'beat_this',
      meter,
      head: { downbeatsSec: headDown.downbeatsSec, confidence: headDown.confidence },
      tail: { downbeatsSec: tailDown.downbeatsSec, confidence: tailDown.confidence },
      confidence: Number((((headDown.confidence ?? 0) + (tailDown.confidence ?? 0)) / 2).toFixed(3)),
    },
  };
}
