/**
 * Phase 7 §7.3. Bar-boundary phrase candidates from a downbeat grid, scored
 * by structural change, proximity to a vocal boundary, and bar-multiple
 * alignment. No ML, no semantic (Aメロ/サビ) labeling — a pure function so it
 * stays testable without spawning ffmpeg/Demucs.
 *
 * `barIndex` is relative to the window's own downbeat sequence (index 0 is
 * the first downbeat detected in that head/tail window), not an absolute
 * track-wide bar count — Phase 7A only analyzes head/tail windows, not the
 * full track.
 */
export const PHRASE_VOCAL_BONUS_WINDOW_SEC = 1.0;
export const PHRASE_SILENCE_DB = -45;
export const PHRASE_STRUCTURAL_SPAN_SEC = 1.5;

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function levelAt(rmsLevels, windowStartSec, frameSec, sec) {
  if (!rmsLevels.length) return null;
  const idx = Math.round((sec - windowStartSec) / frameSec);
  if (idx < 0 || idx >= rmsLevels.length) return null;
  return rmsLevels[idx];
}

function averageLevel(rmsLevels, windowStartSec, frameSec, fromSec, toSec) {
  if (!rmsLevels.length) return null;
  const startIdx = Math.max(0, Math.floor((fromSec - windowStartSec) / frameSec));
  const endIdx = Math.min(rmsLevels.length, Math.ceil((toSec - windowStartSec) / frameSec));
  if (endIdx <= startIdx) return levelAt(rmsLevels, windowStartSec, frameSec, fromSec);
  const slice = rmsLevels.slice(startIdx, endIdx).filter((n) => Number.isFinite(n));
  if (slice.length === 0) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * @param {{
 *   downbeatsSec: number[],
 *   features?: { frameSec?: number, startSec?: number, rmsLevels?: number[] } | null,
 *   vocalActivity?: { boundariesSec?: number[] } | null,
 * }} args
 * @returns {{ sec: number, barIndex: number, score: number, reasons: string[] }[]}
 */
export function buildPhraseCandidates({ downbeatsSec, features = null, vocalActivity = null } = {}) {
  if (!Array.isArray(downbeatsSec) || downbeatsSec.length === 0) return [];

  const rmsLevels = Array.isArray(features?.rmsLevels) ? features.rmsLevels : [];
  const frameSec = features?.frameSec ?? 0.1;
  const windowStartSec = features?.startSec ?? 0;
  const boundaries = Array.isArray(vocalActivity?.boundariesSec)
    ? vocalActivity.boundariesSec.filter((n) => Number.isFinite(n))
    : [];

  return downbeatsSec.map((sec, barIndex) => {
    const reasons = [];
    let score = 0;

    if (barIndex % 8 === 0) {
      score += 0.25;
      reasons.push('bar-multiple-8');
    } else if (barIndex % 4 === 0) {
      score += 0.15;
      reasons.push('bar-multiple-4');
    }

    const before = averageLevel(rmsLevels, windowStartSec, frameSec, sec - PHRASE_STRUCTURAL_SPAN_SEC, sec);
    const after = averageLevel(rmsLevels, windowStartSec, frameSec, sec, sec + PHRASE_STRUCTURAL_SPAN_SEC);
    if (before != null && after != null) {
      const structuralChange = clamp01(Math.abs(after - before) / 12);
      if (structuralChange > 0.05) {
        score += structuralChange * 0.35;
        reasons.push('structural-change');
      }
    }

    if (boundaries.some((b) => Math.abs(b - sec) <= PHRASE_VOCAL_BONUS_WINDOW_SEC)) {
      score += 0.3;
      reasons.push('vocal-boundary');
    }

    const level = levelAt(rmsLevels, windowStartSec, frameSec, sec);
    if (level != null && level <= PHRASE_SILENCE_DB) {
      score += 0.1;
      reasons.push('near-silence');
    }

    return { sec, barIndex, score: Number(clamp01(score).toFixed(3)), reasons };
  });
}
