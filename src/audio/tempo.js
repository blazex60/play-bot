import { spawnCapture } from './spawnCapture.js';

// Phase 7 §8.3 (tempo range, provisional pending real-track calibration in 7E).
export const SOFT_LIMIT_RATIO = 0.04;
export const HARD_LIMIT_RATIO = 0.06;

/**
 * Half/double detection (bpmDelta in src/mix/ordering.js) treats an octave
 * mismatch as "close" for ordering purposes. tempoRatio() must agree with
 * that: normalize nativeBpm into targetBpm's octave band (0.6x-1.4x) before
 * taking a ratio, so beatmix never rejects a pair ordering already picked as
 * a good neighbor. Returns null when no octave of nativeBpm falls in band —
 * an unrelated tempo, not a stretch candidate.
 */
export function normalizeBpmToOctave(nativeBpm, targetBpm) {
  if (!Number.isFinite(nativeBpm) || nativeBpm <= 0) return null;
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) return null;
  const candidates = [nativeBpm, nativeBpm * 2, nativeBpm / 2];
  let best = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    if (candidate < targetBpm * 0.6 || candidate > targetBpm * 1.4) continue;
    const dist = Math.abs(candidate - targetBpm);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/**
 * @returns {number|null} playback speed multiplier for rubberband/atempo
 * `tempo=` (>1 speeds up, <1 slows down), or null if nativeBpm/targetBpm
 * are missing or in unrelated octaves.
 */
export function tempoRatio(nativeBpm, targetBpm) {
  const normalized = normalizeBpmToOctave(nativeBpm, targetBpm);
  if (normalized == null) return null;
  return targetBpm / normalized;
}

/**
 * @returns {{ ok: boolean, ratio: number|null, tier: 'normal'|'marginal'|'exceeds-hard'|null }}
 * 'marginal' (4-6%) is mechanically stretchable but Phase 7C's planner should
 * only take it when confidence/transition conditions are high (§8.3).
 */
export function canTempoMatch(nativeBpm, targetBpm, { softLimit = SOFT_LIMIT_RATIO, hardLimit = HARD_LIMIT_RATIO } = {}) {
  const ratio = tempoRatio(nativeBpm, targetBpm);
  if (ratio == null) return { ok: false, ratio: null, tier: null };
  const deviation = Math.abs(ratio - 1);
  if (deviation > hardLimit) return { ok: false, ratio, tier: 'exceeds-hard' };
  if (deviation > softLimit) return { ok: true, ratio, tier: 'marginal' };
  return { ok: true, ratio, tier: 'normal' };
}

/**
 * Mechanical filter-string builder — does not itself decide beatmix
 * eligibility (that is Phase 7C's planner, which also weighs confidence).
 * `backend` should come from probeTempoBackend(); atempo also shifts pitch,
 * so it is only offered inside SOFT_LIMIT_RATIO (§8.2).
 * @returns {{ filter: string|null, ratio: number|null, backend: 'rubberband'|'atempo'|null }}
 */
export function buildTempoFilter({ nativeBpm, targetBpm, backend = 'rubberband' } = {}) {
  const ratio = tempoRatio(nativeBpm, targetBpm);
  if (ratio == null) return { filter: null, ratio: null, backend: null };
  const deviation = Math.abs(ratio - 1);

  if (backend === 'rubberband') {
    if (deviation > HARD_LIMIT_RATIO) return { filter: null, ratio, backend: null };
    return { filter: `rubberband=tempo=${ratio.toFixed(4)}`, ratio, backend: 'rubberband' };
  }
  if (backend === 'atempo') {
    if (deviation > SOFT_LIMIT_RATIO) return { filter: null, ratio, backend: null };
    return { filter: `atempo=${ratio.toFixed(4)}`, ratio, backend: 'atempo' };
  }
  return { filter: null, ratio, backend: null };
}

let cachedBackendPromise = null;

/**
 * Probes the local ffmpeg build for the rubberband filter (§8.2: bundled in
 * Debian bookworm's ffmpeg, no new package needed), falling back to atempo,
 * then null (beatmix unavailable). Result is memoized process-wide — the
 * ffmpeg binary does not change at runtime.
 */
export async function probeTempoBackend({ spawnFn } = {}) {
  if (cachedBackendPromise) return cachedBackendPromise;
  cachedBackendPromise = (async () => {
    const { stdout, code } = await spawnCapture(spawnFn, 'ffmpeg', ['-hide_banner', '-filters']);
    if (code !== 0) return null;
    if (/\brubberband\b/.test(stdout)) return 'rubberband';
    if (/\batempo\b/.test(stdout)) return 'atempo';
    return null;
  })();
  return cachedBackendPromise;
}

/** Test-only: force the next probeTempoBackend() call to re-probe. */
export function resetTempoBackendProbeCache() {
  cachedBackendPromise = null;
}

/**
 * A time-stretched source's output runs at tempoRatio x native speed, so its
 * playback duration is durationSec / tempoRatio. MixStream.positionSec is
 * stretched-output time (#consumedBytes / BYTES_PER_SECOND), so this must be
 * applied wherever native duration feeds setCurrent/setDurationSec (§8.4) —
 * otherwise remainingSec (and the crossfade arm gate it drives) drifts by
 * the stretch amount over a track's length.
 */
export function compensateDurationSec(durationSec, ratio) {
  if (durationSec == null) return durationSec;
  if (!Number.isFinite(ratio) || ratio <= 0) return durationSec;
  return durationSec / ratio;
}

/** @returns {{ nativeBpm: number|null, playbackBpm: number|null, tempoRatio: number }} */
export function createSessionTempoState() {
  return { nativeBpm: null, playbackBpm: null, tempoRatio: 1 };
}

/**
 * §8.4: incoming promotion without a beatmix transition resets session tempo
 * to the new current track's native BPM (no stretch) — the session never
 * carries a stale tempoRatio into an unrelated track.
 */
export function resetSessionTempo(nativeBpm = null) {
  return { nativeBpm, playbackBpm: nativeBpm, tempoRatio: 1 };
}

/**
 * §2.3/§8.4: tempo is decided once, at spawn time, and held for the rest of
 * that track's playback — this only computes the state to spawn *with*.
 * Falls back to resetSessionTempo() (native, unstretched) when nativeBpm is
 * unknown or the target is outside the backend's stretch range.
 */
export function applySessionTempo(nativeBpm, targetBpm, { backend = 'rubberband' } = {}) {
  const built = buildTempoFilter({ nativeBpm, targetBpm, backend });
  if (!built.filter) return resetSessionTempo(nativeBpm);
  return { nativeBpm, playbackBpm: targetBpm, tempoRatio: built.ratio };
}
