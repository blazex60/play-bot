/**
 * Simple Direct Form I biquad for s16le stereo PCM frames.
 * Coefficients are computed for the given sample rate.
 */
export function designHighpass(sampleRate, cutoffHz, q = 0.7071) {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  return normalize({ b0, b1, b2, a0, a1, a2 });
}

export function designLowshelf(sampleRate, cutoffHz, gainDb, q = 0.7071) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const b0 = A * ((A + 1) - (A - 1) * cos + twoSqrtAAlpha);
  const b1 = 2 * A * ((A - 1) - (A + 1) * cos);
  const b2 = A * ((A + 1) - (A - 1) * cos - twoSqrtAAlpha);
  const a0 = (A + 1) + (A - 1) * cos + twoSqrtAAlpha;
  const a1 = -2 * ((A - 1) + (A + 1) * cos);
  const a2 = (A + 1) + (A - 1) * cos - twoSqrtAAlpha;
  return normalize({ b0, b1, b2, a0, a1, a2 });
}

function normalize({ b0, b1, b2, a0, a1, a2 }) {
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

export function createBiquadProcessor(coeffs) {
  // Per-channel history: x1,x2,y1,y2
  const state = [
    { x1: 0, x2: 0, y1: 0, y2: 0 },
    { x1: 0, x2: 0, y1: 0, y2: 0 },
  ];
  const { b0, b1, b2, a1, a2 } = coeffs;

  return function processFrame(frame) {
    const view = new Int16Array(frame.buffer, frame.byteOffset, frame.byteLength / 2);
    for (let i = 0; i < view.length; i++) {
      const ch = i & 1;
      const s = state[ch];
      const x0 = view[i] / 32768;
      const y0 = b0 * x0 + b1 * s.x1 + b2 * s.x2 - a1 * s.y1 - a2 * s.y2;
      s.x2 = s.x1;
      s.x1 = x0;
      s.y2 = s.y1;
      s.y1 = y0;
      const sample = y0 * 32768;
      view[i] = sample > 32767 ? 32767 : sample < -32768 ? -32768 : sample;
    }
    return frame;
  };
}

/** Outgoing track: highpass ~120Hz to hand bass to the incoming track. */
export function createOutgoingBaseSwapProcessor(sampleRate = 48000, cutoffHz = 120) {
  return createBiquadProcessor(designHighpass(sampleRate, cutoffHz));
}

/** Incoming track: mild lowshelf to establish bass presence. */
export function createIncomingBaseSwapProcessor(sampleRate = 48000, cutoffHz = 120, gainDb = 2) {
  return createBiquadProcessor(designLowshelf(sampleRate, cutoffHz, gainDb));
}
