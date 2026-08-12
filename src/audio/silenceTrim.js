/**
 * Leading/trailing silence trim for MIX crossfade.
 *
 * Applied offline on normalized downloads so remainingSec / analysis /
 * fade windows sit on audible audio rather than YouTube padding.
 *
 * Uses silencedetect + atrim (streaming) — never areverse (whole-clip RAM)
 * and never stop_periods (wipes mid-track pauses).
 */

/** Peak / noise threshold for "silence" (digital padding / soft YouTube tails). */
export const SILENCE_TRIM_THRESHOLD_DB = -50;

/** Keep a tiny pad so attack/release are not clipped. */
export const SILENCE_TRIM_KEEP_SEC = 0.02;

/** Minimum silence length silencedetect must report. */
export const SILENCE_DETECT_MIN_SEC = 0.05;

/**
 * @deprecated Prefer resolveEdgeTrimWindow + atrim. Kept for callers that still
 * expect a single -af string; leading-only silenceremove (no areverse/stop).
 */
export function buildSilenceTrimFilter({
  thresholdDb = SILENCE_TRIM_THRESHOLD_DB,
  keepSec = SILENCE_TRIM_KEEP_SEC,
} = {}) {
  const thr = `${thresholdDb}dB`;
  return [
    'silenceremove=',
    `start_periods=1:start_duration=0:start_threshold=${thr}:start_silence=${keepSec}:`,
    'detection=peak',
  ].join('');
}

export const SILENCE_TRIM_FILTER = buildSilenceTrimFilter();

/**
 * Parse ffmpeg silencedetect stderr into start/end lists (seconds).
 * @param {string} stderr
 * @returns {{ starts: number[], ends: number[] }}
 */
export function parseSilenceDetectLog(stderr) {
  const text = String(stderr ?? '');
  const starts = [...text.matchAll(/silence_start:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  return {
    starts: starts.filter((n) => Number.isFinite(n)),
    ends: ends.filter((n) => Number.isFinite(n)),
  };
}

/**
 * Compute atrim start/end so only silence attached to file edges is removed.
 * Mid-track silence is left intact.
 *
 * @param {{
 *   durationSec: number,
 *   silenceStarts: number[],
 *   silenceEnds: number[],
 *   keepSec?: number,
 * }} args
 * @returns {{ startSec: number, endSec: number, changed: boolean }}
 */
export function resolveEdgeTrimWindow({
  durationSec,
  silenceStarts,
  silenceEnds,
  keepSec = SILENCE_TRIM_KEEP_SEC,
} = {}) {
  if (!(durationSec > 0)) {
    return { startSec: 0, endSec: 0, changed: false };
  }

  let startSec = 0;
  let endSec = durationSec;

  // Leading pad: first silence must begin at/near t=0.
  const firstStart = silenceStarts[0];
  if (firstStart != null && firstStart <= 0.05) {
    const firstEnd = silenceEnds[0];
    if (firstEnd != null && firstEnd > keepSec) {
      startSec = Math.max(0, firstEnd - keepSec);
    }
  }

  // Trailing pad: last silence must reach EOF (no silence_end, or end ≈ duration).
  const lastStart = silenceStarts[silenceStarts.length - 1];
  if (lastStart != null && lastStart < durationSec - keepSec) {
    // Pair starts with ends in order; a trailing run often has no silence_end.
    const pairedEnds = silenceEnds.length;
    const unpairedTrailing = silenceStarts.length > pairedEnds;
    const lastEnd = silenceEnds[silenceEnds.length - 1];
    const reachesEof = unpairedTrailing
      || (lastEnd != null && lastEnd >= durationSec - 0.05);
    // Ensure this silence is the one at the end, not an earlier mid-track gap
    // whose end was near EOF by coincidence.
    const isEdgeTrailing = unpairedTrailing
      ? lastStart >= startSec
      : (lastEnd != null && lastEnd >= durationSec - 0.05 && lastStart >= startSec);
    if (reachesEof && isEdgeTrailing && lastStart > startSec + 0.01) {
      endSec = Math.min(durationSec, lastStart + keepSec);
    }
  }

  if (endSec <= startSec + 0.01) {
    return { startSec: 0, endSec: durationSec, changed: false };
  }

  const changed = startSec > 0.01 || endSec < durationSec - 0.01;
  return { startSec, endSec, changed };
}

/**
 * Build atrim filter for an edge trim window.
 * @param {{ startSec: number, endSec: number }} window
 */
export function buildAtrimFilter({ startSec, endSec }) {
  const start = Math.max(0, startSec);
  const end = Math.max(start, endSec);
  return `atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS`;
}
