/**
 * Build a transition plan between two track analyses.
 *
 * Modes:
 * - crossfade: analysis-driven overlap + base-swap EQ
 * - simple-fade: short equal-power fade, no EQ (low confidence / missing next analysis)
 * - gapless: hard handoff (fadeSec = 0)
 */
export function planTransition(outgoing, incoming, { maxOverlapSec = 6 } = {}) {
  if (!outgoing) {
    return {
      mode: 'gapless',
      fadeSec: 0,
      curve: 'linear',
      baseSwap: false,
      reason: 'missing-outgoing-analysis',
    };
  }

  const conf = Math.min(
    outgoing.confidence ?? 0,
    incoming?.confidence ?? outgoing.confidence ?? 0,
  );

  // Two-stage fallback from mix-plan §7.
  if (conf < 0.35 || !incoming) {
    return {
      mode: 'gapless',
      fadeSec: 0,
      curve: 'linear',
      baseSwap: false,
      reason: conf < 0.35 ? 'low-confidence' : 'missing-incoming-analysis',
      confidence: conf,
    };
  }

  let fadeSec = outgoing.recommendedOverlapSec ?? 2;
  // Vocal-safe clamp while vocal detection is weak (Phase 1.5 conclusion).
  if ((outgoing.vocalConfidence ?? 0) < 0.5) {
    fadeSec = Math.min(fadeSec, 2);
  }
  fadeSec = Math.min(fadeSec, maxOverlapSec, Math.max(0.5, (outgoing.durationSec ?? 60) * 0.1));

  if (conf < 0.55) {
    return {
      mode: 'simple-fade',
      fadeSec: Math.min(fadeSec, 1.5),
      curve: 'equal-power',
      baseSwap: false,
      reason: 'medium-confidence',
      confidence: conf,
      outgoingBpm: outgoing.bpm ?? null,
      incomingBpm: incoming.bpm ?? null,
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
