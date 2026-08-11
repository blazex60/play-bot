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

/** Soft-clip samples in-place on an Int16 interleaved stereo frame. */
export function softLimitFrame(frame, ceiling = 0.95) {
  const view = new Int16Array(frame.buffer, frame.byteOffset, frame.byteLength / 2);
  const max = 32767 * ceiling;
  for (let i = 0; i < view.length; i++) {
    const x = view[i] / 32768;
    // cubic soft clip
    const y = x < -1 ? -1 : x > 1 ? 1 : x - (x * x * x) / 3;
    const scaled = y * 32768;
    view[i] = scaled > max ? max : scaled < -max ? -max : scaled;
  }
  return frame;
}

/**
 * Mix two s16le frames with gains. Applies OVERLAP_GAIN then soft-limit.
 * @returns {Buffer}
 */
export function mixFrames(outFrame, inFrame, outGain, inGain) {
  const out = Buffer.allocUnsafe(FRAME_BYTES);
  const a = new Int16Array(outFrame.buffer, outFrame.byteOffset, FRAME_BYTES / 2);
  const b = new Int16Array(inFrame.buffer, inFrame.byteOffset, FRAME_BYTES / 2);
  const dest = new Int16Array(out.buffer, out.byteOffset, FRAME_BYTES / 2);
  const gOut = outGain * OVERLAP_GAIN;
  const gIn = inGain * OVERLAP_GAIN;
  for (let i = 0; i < dest.length; i++) {
    const sample = a[i] * gOut + b[i] * gIn;
    dest[i] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
  }
  softLimitFrame(out);
  return out;
}
