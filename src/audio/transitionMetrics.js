/**
 * Phase 9A (docs/mix-transition-phase9.md §3.3): in-process transition
 * metrics accumulator. Deliberately memory-only — no DB table, no file
 * write. Bot process never opens SQLite (CLAUDE.md), and per the doc,
 * 永続保存は必須ではない for this phase. Restarting the process resets the
 * counters; that's fine for the intended use ("explain what happened during
 * this run's live playback sessions"), not a dashboard/analytics feature.
 *
 * transitionLog.js is the only intended caller (via recordTransition()) —
 * every #maybeStartCrossfade() commit funnels through logTransitionPlan(),
 * which calls this unconditionally regardless of MIX_DEBUG (§3's own
 * requirement: metrics stay always-on even when the verbose log is off).
 */

/**
 * Canonical camelCase keys for the `selected.*` / mode buckets, matching the
 * doc's §3.3 example (`stemMix`, `beatmix`, `phraseCrossfade`, `crossfade`,
 * `tailFade`). Any mode string not listed here still gets counted (see
 * modeKey() below) — this is just presentation, not a gate.
 */
const MODE_KEYS = {
  'stem-mix': 'stemMix',
  beatmix: 'beatmix',
  'phrase-crossfade': 'phraseCrossfade',
  crossfade: 'crossfade',
  'tail-fade': 'tailFade',
  'simple-fade': 'simpleFade',
  gapless: 'gapless',
};

function modeKey(mode) {
  if (!mode) return 'unknown';
  return MODE_KEYS[mode] ?? mode;
}

function emptyState() {
  return {
    totalTransitions: 0,
    selected: {},
    stemCache: {
      outgoingHit: 0,
      outgoingMiss: 0,
      incomingHit: 0,
      incomingMiss: 0,
    },
  };
}

let state = emptyState();

/**
 * Record one transition's outcome. Called exactly once per actual
 * transition commit (not once per ~200ms arm-tick re-evaluation — see
 * player.js's #maybeStartCrossfade docstring for why those two are not the
 * same thing).
 * @param {{ selected: string, stemCache?: { outgoing?: 'hit'|'miss'|null, incoming?: 'hit'|'miss'|null } }} entry
 */
export function recordTransition({ selected, stemCache = {} } = {}) {
  state.totalTransitions += 1;
  const key = modeKey(selected);
  state.selected[key] = (state.selected[key] ?? 0) + 1;

  if (stemCache.outgoing === 'hit') state.stemCache.outgoingHit += 1;
  else if (stemCache.outgoing === 'miss') state.stemCache.outgoingMiss += 1;

  if (stemCache.incoming === 'hit') state.stemCache.incomingHit += 1;
  else if (stemCache.incoming === 'miss') state.stemCache.incomingMiss += 1;
}

/** @returns {{ totalTransitions: number, selected: Record<string, number>, stemCache: object }} a snapshot copy — mutating the result does not affect accumulated state. */
export function getTransitionMetrics() {
  return {
    totalTransitions: state.totalTransitions,
    selected: { ...state.selected },
    stemCache: { ...state.stemCache },
  };
}

/** Test-only: reset the module-level accumulator between test cases. */
export function resetTransitionMetrics() {
  state = emptyState();
}
