/** Default overlap when analysis is not ready yet (mix-plan §7 simple-fade). */
export const DEFAULT_OVERLAP_SEC = 1.5;

/**
 * Build a transition plan between two track analyses.
 *
 * Modes:
 * - crossfade: analysis-driven overlap + base-swap EQ
 * - simple-fade: short equal-power fade, no EQ (low confidence / missing analysis)
 * - gapless: hard handoff (fadeSec = 0) — last resort only
 */
export function planTransition(outgoing, incoming, { maxOverlapSec = 6 } = {}) {
  if (!outgoing) {
    return {
      mode: 'simple-fade',
      fadeSec: DEFAULT_OVERLAP_SEC,
      curve: 'equal-power',
      baseSwap: false,
      reason: 'missing-outgoing-analysis',
    };
  }

  const conf = Math.min(
    outgoing.confidence ?? 0,
    incoming?.confidence ?? outgoing.confidence ?? 0,
  );

  let fadeSec = outgoing.recommendedOverlapSec ?? DEFAULT_OVERLAP_SEC;
  // Vocal-safe clamp while vocal detection is weak (Phase 1.5 conclusion).
  if ((outgoing.vocalConfidence ?? 0) < 0.5) {
    fadeSec = Math.min(fadeSec, 2);
  }
  fadeSec = Math.min(fadeSec, maxOverlapSec, Math.max(0.5, (outgoing.durationSec ?? 60) * 0.1));

  // Two-stage fallback from mix-plan §7: crossfade → simple-fade → gapless.
  if (conf < 0.2) {
    return {
      mode: 'gapless',
      fadeSec: 0,
      curve: 'linear',
      baseSwap: false,
      reason: 'very-low-confidence',
      confidence: conf,
    };
  }

  if (conf < 0.55 || !incoming) {
    return {
      mode: 'simple-fade',
      fadeSec: Math.min(fadeSec, conf < 0.35 ? 1 : 1.5),
      curve: 'equal-power',
      baseSwap: false,
      reason: !incoming ? 'missing-incoming-analysis' : 'medium-confidence',
      confidence: conf,
      outgoingBpm: outgoing.bpm ?? null,
      incomingBpm: incoming?.bpm ?? null,
    };
  }

  return {
    mode: 'crossfade',
    fadeSec,
    curve: 'equal-power',
    baseSwap: true,
    highpassHz: 120,
    lowshelfGainDb: 2,
    reason: 'high-confidence',
    confidence: conf,
    outgoingBpm: outgoing.bpm ?? null,
    incomingBpm: incoming.bpm ?? null,
    outgoingTailKey: outgoing.tailKey ?? null,
    incomingHeadKey: incoming.headKey ?? null,
  };
}
