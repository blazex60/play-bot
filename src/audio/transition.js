/** Default overlap when analysis is not ready yet (mix-plan §7 simple-fade). */
export const DEFAULT_OVERLAP_SEC = 1.5;
export const TAIL_FADE_SEC = 0.6;
export const MIN_VOCAL_WINDOW_SEC = 0.8;
export const VOCAL_CONFIDENCE_READY = 0.5;
export const BPM_CONFIDENCE_SNAP = 0.5;

function isHalfDouble(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  const ratio = a > b ? a / b : b / a;
  return ratio > 1.8 && ratio < 2.2;
}

export function overlapWindowSec(outgoing) {
  if (!outgoing) return null;
  const duration = outgoing.durationSec;
  const lastVocal = outgoing.lastVocalEndSec;
  if (!(duration > 0) || lastVocal == null || !Number.isFinite(lastVocal)) return null;
  return Math.max(0, duration - lastVocal);
}

/**
 * Snap a crossfade start to a bar boundary inside the vocal-free window.
 * Bar phase comes from the detected tail beat grid when available; vocals
 * remain a hard floor (never snap earlier than lastVocalEndSec).
 * Only snaps earlier than the planned start. Never into vocals.
 * @returns {{ startSec: number, fadeSec: number, snapToBeat: boolean }}
 */
export function snapStartToBar({
  startSec,
  fadeSec,
  lastVocalEndSec,
  durationSec,
  bpm,
  beatAnchorSec = null,
  allowSnap,
}) {
  if (!allowSnap || !(bpm > 0) || !(durationSec > 0)) {
    return { startSec, fadeSec, snapToBeat: false };
  }
  const barSec = (60 / bpm) * 4;
  if (!(barSec > 0.2) || barSec > 8) {
    return { startSec, fadeSec, snapToBeat: false };
  }
  const floor = lastVocalEndSec ?? 0;
  const anchor = Number.isFinite(beatAnchorSec) ? beatAnchorSec : floor;
  const n = Math.floor((startSec - anchor) / barSec + 1e-9);
  let snapped = anchor + n * barSec;
  if (snapped < floor - 1e-6) {
    const nFloor = Math.ceil((floor - anchor) / barSec - 1e-9);
    snapped = anchor + nFloor * barSec;
  }
  if (snapped < floor - 1e-6 || snapped > startSec + 1e-6) {
    return { startSec, fadeSec, snapToBeat: false };
  }
  const snappedFade = durationSec - snapped;
  if (snappedFade < MIN_VOCAL_WINDOW_SEC) {
    return { startSec, fadeSec, snapToBeat: false };
  }
  return { startSec: snapped, fadeSec: snappedFade, snapToBeat: true };
}

function simpleFade(reason, fadeSec = DEFAULT_OVERLAP_SEC) {
  return {
    mode: 'simple-fade',
    fadeSec,
    curve: 'equal-power',
    baseSwap: false,
    snapToBeat: false,
    startSec: null,
    incomingOffsetSec: 0,
    reason,
  };
}

/**
 * Build a transition plan between two track analyses.
 *
 * Modes:
 * - crossfade: vocal-free overlap + base-swap EQ
 * - tail-fade: fade outgoing only, then start incoming (no overlap)
 * - simple-fade: short equal-power fade, no EQ (analysis not ready)
 * - gapless: hard handoff (fadeSec = 0)
 */
export function planTransition(outgoing, incoming, { maxOverlapSec = 6 } = {}) {
  if (!outgoing) {
    return simpleFade('missing-outgoing-analysis');
  }

  const conf = outgoing.confidence ?? 0;
  if (conf > 0 && conf < 0.2 && (outgoing.vocalConfidence ?? 0) < VOCAL_CONFIDENCE_READY) {
    return {
      mode: 'gapless',
      fadeSec: 0,
      curve: 'linear',
      baseSwap: false,
      snapToBeat: false,
      startSec: null,
      incomingOffsetSec: 0,
      reason: 'very-low-confidence',
      confidence: conf,
    };
  }

  const vocalReady = (outgoing.vocalConfidence ?? 0) >= VOCAL_CONFIDENCE_READY
    && outgoing.lastVocalEndSec != null
    && Number.isFinite(outgoing.lastVocalEndSec);
  const durationSec = outgoing.durationSec ?? 60;
  const windowSec = overlapWindowSec(outgoing);

  if (!vocalReady) {
    const fadeSec = Math.min(
      outgoing.recommendedOverlapSec ?? DEFAULT_OVERLAP_SEC,
      1.5,
      Math.max(0.5, durationSec * 0.1),
    );
    return {
      ...simpleFade('analysis-not-ready', fadeSec),
      confidence: conf,
      outgoingBpm: outgoing.bpm ?? null,
      incomingBpm: incoming?.bpm ?? null,
    };
  }

  if (windowSec < MIN_VOCAL_WINDOW_SEC) {
    return {
      mode: 'tail-fade',
      fadeSec: TAIL_FADE_SEC,
      curve: 'equal-power',
      baseSwap: false,
      snapToBeat: false,
      startSec: Math.max(0, durationSec - TAIL_FADE_SEC),
      incomingOffsetSec: incoming?.headBeatOffsetSec ?? 0,
      reason: 'vocal-to-end',
      confidence: conf,
      outgoingBpm: outgoing.bpm ?? null,
      incomingBpm: incoming?.bpm ?? null,
      lastVocalEndSec: outgoing.lastVocalEndSec,
    };
  }

  let fadeSec = outgoing.recommendedOverlapSec ?? DEFAULT_OVERLAP_SEC;
  fadeSec = Math.min(
    fadeSec,
    windowSec,
    maxOverlapSec,
    Math.max(0.5, durationSec * 0.1),
  );
  let startSec = durationSec - fadeSec;
  if (startSec < outgoing.lastVocalEndSec) {
    startSec = outgoing.lastVocalEndSec;
    fadeSec = Math.max(0, durationSec - startSec);
  }

  const bpm = outgoing.bpm ?? incoming?.bpm ?? null;
  const bpmConfidence = Math.min(
    outgoing.bpmConfidence ?? 0,
    incoming?.bpmConfidence ?? outgoing.bpmConfidence ?? 0,
  );
  const halfDouble = isHalfDouble(outgoing.bpm, outgoing.headBpm)
    || isHalfDouble(outgoing.bpm, incoming?.bpm);
  const allowSnap = bpmConfidence >= BPM_CONFIDENCE_SNAP && !halfDouble && bpm != null;
  const snapped = snapStartToBar({
    startSec,
    fadeSec,
    lastVocalEndSec: outgoing.lastVocalEndSec,
    durationSec,
    bpm,
    beatAnchorSec: outgoing.tailBeatOffsetSec,
    allowSnap,
  });

  const incomingOffsetSec = Number.isFinite(incoming?.headBeatOffsetSec)
    ? Math.max(0, incoming.headBeatOffsetSec)
    : 0;

  return {
    mode: 'crossfade',
    fadeSec: snapped.fadeSec,
    startSec: snapped.startSec,
    curve: 'equal-power',
    baseSwap: true,
    highpassHz: 120,
    lowshelfGainDb: 2,
    snapToBeat: snapped.snapToBeat,
    incomingOffsetSec,
    reason: 'vocal-free-window',
    confidence: conf,
    outgoingBpm: outgoing.bpm ?? null,
    incomingBpm: incoming?.bpm ?? null,
    outgoingTailKey: outgoing.tailKey ?? null,
    incomingHeadKey: incoming?.headKey ?? null,
    lastVocalEndSec: outgoing.lastVocalEndSec,
  };
}
