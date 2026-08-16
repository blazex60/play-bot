export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;
export const FRAME_MS = 20;
export const FRAME_BYTES = SAMPLE_RATE * (FRAME_MS / 1000) * CHANNELS * BYTES_PER_SAMPLE;
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;

/** Crossfade overlap headroom to reduce clipping when summing two -16 LUFS streams. */
export const OVERLAP_GAIN = 10 ** (-3 / 20);

/**
 * @param {{ positionSec: number, fadeSec?: number, curve?: 'linear'|'equal-power', role?: 'out'|'in' }} args
 * @returns {number} gain 0..1
 */
export function gainForPosition({ positionSec, fadeSec = 0, curve = 'equal-power', role = 'out' }) {
  if (!(fadeSec > 0)) return 1;
  const t = Math.min(1, Math.max(0, positionSec / fadeSec));
  if (curve === 'linear') {
    return role === 'out' ? 1 - t : t;
  }
  // equal-power
  const angle = (t * Math.PI) / 2;
  return role === 'out' ? Math.cos(angle) : Math.sin(angle);
}

/** Scale a s16le frame by gain (0..1). Returns a copy. */
export function scaleFrame(frame, gain) {
  const out = Buffer.from(frame);
  const view = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);
  const g = Number.isFinite(gain) ? gain : 1;
  for (let i = 0; i < view.length; i++) {
    const sample = Math.round(view[i] * g);
    view[i] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
  }
  return out;
}

/**
 * Linear-interpolate two same-length s16le frames sample-by-sample.
 * mix=0 -> dry, mix=1 -> wet. Used to ramp an EQ effect in/out gradually
 * (Phase 7 §11.1 bar-envelope bass swap) instead of switching it on/off
 * instantly for the whole crossfade.
 * @returns {Buffer}
 */
export function blendFrame(dry, wet, mix) {
  if (!(mix > 0)) return dry;
  if (mix >= 1) return wet;
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  const a = new Int16Array(dry.buffer, dry.byteOffset, FRAME_BYTES / 2);
  const b = new Int16Array(wet.buffer, wet.byteOffset, FRAME_BYTES / 2);
  const dest = new Int16Array(out.buffer, out.byteOffset, FRAME_BYTES / 2);
  for (let i = 0; i < dest.length; i++) {
    const v = a[i] * (1 - mix) + b[i] * mix;
    dest[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }
  return out;
}

/**
 * Soft-knee limiter on an Int16 interleaved stereo frame, in-place. Unity
 * (no change) below `ceiling`; above it, the excess is compressed through
 * tanh() so the transfer function stays continuous (value and slope) right
 * at the threshold — a hard switch from unity to a curve (as in an earlier
 * version of this function) creates a large discontinuity exactly at the
 * boundary, which is audible as a click/crackle whenever a waveform hovers
 * near the ceiling. tanh asymptotically approaches ceiling + headroom (< 1)
 * as excess grows, so output never reaches full scale.
 */
export function softLimitFrame(frame, ceiling = 0.95) {
  const view = new Int16Array(frame.buffer, frame.byteOffset, frame.byteLength / 2);
  const threshold = ceiling;
  const headroom = 1 - threshold;
  for (let i = 0; i < view.length; i++) {
    const x = view[i] / 32768;
    const abs = x < 0 ? -x : x;
    if (abs <= threshold) continue;
    const excess = abs - threshold;
    const compressed = headroom * Math.tanh(excess / headroom);
    const y = (threshold + compressed) * (x < 0 ? -1 : 1);
    view[i] = Math.round(y * 32768);
  }
  return frame;
}

/**
 * Mix two s16le frames with gains. Applies OVERLAP_GAIN, soft-limits in float
 * domain, then clamps to int16 (soft-limit must run before hard clip).
 * @returns {Buffer}
 */
export function mixFrames(outFrame, inFrame, outGain, inGain) {
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  const a = new Int16Array(outFrame.buffer, outFrame.byteOffset, FRAME_BYTES / 2);
  const b = new Int16Array(inFrame.buffer, inFrame.byteOffset, FRAME_BYTES / 2);
  const dest = new Int16Array(out.buffer, out.byteOffset, FRAME_BYTES / 2);
  const gOut = outGain * OVERLAP_GAIN;
  const gIn = inGain * OVERLAP_GAIN;
  const ceiling = 0.95;
  const max = 32767 * ceiling;
  for (let i = 0; i < dest.length; i++) {
    const x = (a[i] * gOut + b[i] * gIn) / 32768;
    // cubic soft clip (same transfer as softLimitFrame)
    const y = x < -1 ? -1 : x > 1 ? 1 : x - (x * x * x) / 3;
    const scaled = y * 32768;
    dest[i] = scaled > max ? max : scaled < -max ? -max : scaled;
  }
  return out;
}
