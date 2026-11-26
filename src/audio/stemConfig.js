/**
 * Stem-separation tuning and window geometry (.omc/plans/stem-separation-fix.md).
 *
 * Pure module (no fs / child_process) so the cache, the analysis queue, the
 * transition planner and the source preparer can all share it without
 * import cycles.
 *
 * Calibrated on the production host (2026-11-25, 8 vCPU QEMU, htdemucs,
 * nice 15): at 4 threads separation takes ≈ 1.24 × audioSec + 7 s; 8 threads
 * is only 7-8% faster while burning ~6.5 cores, and 1 thread (the old
 * default) needed 1231 s for a 336 s track — every production separation
 * timed out at the old fixed 600 s limit.
 */

/** Seconds from the start of a track kept as the "head" stem window (entry side). */
export const STEM_HEAD_WINDOW_SEC = 60;
/**
 * Seconds from the end kept as the "tail" window (exit side). Sized for the
 * widest stem-mix plan: 16 bars at 80 BPM is 48 s of playback, × the 6% hard
 * tempo limit ≈ 51 s of native audio, plus room for the exit point itself to
 * sit a little before that span.
 */
export const STEM_TAIL_WINDOW_SEC = 75;
/**
 * Tracks this short are separated whole (one window covering everything):
 * cutting head + tail would leave a gap too small to be worth the extra
 * bookkeeping, and the cost is about the same.
 */
export const STEM_FULL_TRACK_MAX_SEC = STEM_HEAD_WINDOW_SEC + STEM_TAIL_WINDOW_SEC + 15;
/** Max incoming-side native/playback ratio (tempo.js HARD_LIMIT_RATIO = 6%). */
const INCOMING_SPAN_RATIO = 1.06;
/**
 * Margin kept INSIDE a window's end (decoder/seek rounding). Inward on
 * purpose: a span that runs past the end would hit EOF on the stem file and
 * drop to silence near full gain, so the check errs toward rejecting.
 */
const COVERAGE_MARGIN_SEC = 0.5;
/**
 * Extra incoming playback the mixer may read from the stems after the
 * overlap ends: MixStream holds promotion for up to MAX_STEM_CATCHUP_HOLD_TICKS
 * (50 × 20 ms) while a stalled stem catches up.
 */
const PROMOTION_HOLD_SEC = 1;

function readNumber(env, name, fallback, { min = 0, integer = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return integer ? Math.floor(value) : value;
}

function readBool(env, name, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  return fallback;
}

/**
 * Read at call time (not module load) so tests and a restarted bot both see
 * the current environment.
 */
export function stemSeparationConfig(env = process.env) {
  return {
    /** STEM_SEPARATION_ENABLED=false turns separation off entirely (stem-mix then never qualifies). */
    enabled: readBool(env, 'STEM_SEPARATION_ENABLED', true),
    /** OMP/MKL threads for Demucs on the stem queue. 4 is the measured sweet spot. */
    threads: readNumber(env, 'DEMUCS_THREADS', 4, { min: 1, integer: true }),
    /** Seconds of compute per second of audio at the configured thread count. */
    rtf: readNumber(env, 'STEM_SEPARATION_RTF', 1.25, { min: 0.05 }),
    /** Fixed per-run cost (model load etc.). */
    fixedSec: readNumber(env, 'STEM_SEPARATION_FIXED_SEC', 10, { min: 0 }),
    /** Headroom for CPU contention with playback and other bots. */
    safetyFactor: readNumber(env, 'STEM_SEPARATION_SAFETY', 2, { min: 1 }),
    /** Hard upper bound on any single separation run. */
    timeoutCapMs: readNumber(env, 'STEM_SEPARATION_TIMEOUT_MS', 600_000, { min: 1000 }),
    /** Consecutive failures that open the circuit breaker. */
    circuitFailures: readNumber(env, 'STEM_CIRCUIT_FAILURES', 5, { min: 1, integer: true }),
    /** How long the breaker stays open. */
    circuitCooldownMs: readNumber(env, 'STEM_CIRCUIT_COOLDOWN_MS', 60 * 60_000, { min: 0 }),
  };
}

/** Timeout for separating `audioSec` seconds of audio; the cap when the length is unknown. */
export function estimateSeparationTimeoutMs(audioSec, config = stemSeparationConfig()) {
  if (!Number.isFinite(audioSec) || audioSec <= 0) return config.timeoutCapMs;
  const estimateMs = (config.rtf * audioSec + config.fixedSec) * config.safetyFactor * 1000;
  return Math.round(Math.min(config.timeoutCapMs, estimateMs));
}

/**
 * Which windows to separate for a track of `durationSec` (native seconds of
 * the normalized file the analysis also ran on). Unknown length → the whole
 * file as one open-ended window, i.e. the pre-window behavior.
 * @returns {{ name: 'full'|'head'|'tail', startSec: number, endSec: number|null }[]}
 */
export function planStemWindows(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec <= STEM_FULL_TRACK_MAX_SEC) {
    return [{ name: 'full', startSec: 0, endSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null }];
  }
  return [
    { name: 'head', startSec: 0, endSec: STEM_HEAD_WINDOW_SEC },
    { name: 'tail', startSec: durationSec - STEM_TAIL_WINDOW_SEC, endSec: durationSec },
  ];
}

/** Total seconds of audio the windows cover (what Demucs actually has to chew through). */
export function stemWindowsAudioSec(windows) {
  let total = 0;
  for (const w of windows) {
    if (w.endSec == null) return null;
    total += Math.max(0, w.endSec - w.startSec);
  }
  return total;
}

/**
 * Normalizes whatever a getCachedStems()-style lookup returned into a
 * window list. Accepts both the windowed shape (`{ windows: [...] }`) and
 * the original full-track shape (`{ vocalPath, instrumentalPath }`), which
 * is treated as one window covering the whole track.
 */
export function stemWindowsOf(stems) {
  if (!stems) return [];
  if (Array.isArray(stems.windows)) return stems.windows;
  if (stems.vocalPath && stems.instrumentalPath) {
    return [{ name: 'full', startSec: 0, endSec: null, vocalPath: stems.vocalPath, instrumentalPath: stems.instrumentalPath }];
  }
  return [];
}

/**
 * The window that holds native [startSec, startSec + spanSec], or null.
 * `endSec: null` means "to the end of the track".
 */
export function findStemWindow(stems, startSec, spanSec = 0, { endMarginSec = COVERAGE_MARGIN_SEC } = {}) {
  if (!Number.isFinite(startSec)) return null;
  const endNeeded = startSec + Math.max(0, spanSec);
  for (const w of stemWindowsOf(stems)) {
    // Never accept a start before the window: the opener clamps the seek to
    // 0, which would play stem audio offset from the full mix it replaces.
    // `endMarginSec` defaults to the playback margin; analysis that only
    // reads levels (and tolerates ffmpeg stopping at EOF) may pass a
    // negative value to accept a window ending a hair before the span.
    const startsOk = startSec >= w.startSec;
    const endsOk = w.endSec == null || endNeeded <= w.endSec - endMarginSec;
    if (startsOk && endsOk) return w;
  }
  return null;
}

/**
 * Whether a stem-mix pair's overlap fits inside both sides' stem windows.
 * Outgoing native span = fadeSec × outgoingRatio (ratio is native/playback,
 * see beatmixTransition.js roomAfterExitPlayback); the incoming side is
 * bounded by the hard tempo limit.
 */
export function stemPairCovered({ outgoingStems, incomingStems }, { exitSec, entrySec, fadeSec, outgoingRatio = 1 }) {
  const outSpan = fadeSec * Math.max(outgoingRatio, 1 / outgoingRatio, 1);
  const inSpan = (fadeSec + PROMOTION_HOLD_SEC) * INCOMING_SPAN_RATIO;
  return Boolean(findStemWindow(outgoingStems, exitSec, outSpan) && findStemWindow(incomingStems, entrySec, inSpan));
}
