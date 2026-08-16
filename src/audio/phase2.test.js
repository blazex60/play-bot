import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gainForPosition, mixFrames, FRAME_BYTES, OVERLAP_GAIN, blendFrame, softLimitFrame } from './fade.js';
import { planTransition, snapStartToBar } from './transition.js';
import { recommendOverlapSec } from './trackAnalysis.js';
import { designHighpass, createBiquadProcessor } from './eq.js';
import { MixStream } from './mixStream.js';
import { PcmSource } from './pcmSource.js';

function createPendingSource() {
  // Simulates a late ffmpeg/yt-dlp startup: open, not ended, no PCM yet.
  const source = new EventEmitter();
  source.ended = false;
  source.error = null;
  source.read = () => null;
  source.destroy = () => {
    source.removeAllListeners();
    source.ended = true;
  };
  return source;
}

test('gainForPosition equal-power out/in are complementary in power', () => {
  const out = gainForPosition({ positionSec: 0.5, fadeSec: 1, curve: 'equal-power', role: 'out' });
  const inn = gainForPosition({ positionSec: 0.5, fadeSec: 1, curve: 'equal-power', role: 'in' });
  assert.ok(Math.abs((out * out + inn * inn) - 1) < 1e-6);
});

test('mixFrames applies overlap gain headroom', () => {
  const a = Buffer.alloc(FRAME_BYTES);
  const b = Buffer.alloc(FRAME_BYTES);
  const av = new Int16Array(a.buffer);
  const bv = new Int16Array(b.buffer);
  av.fill(10000);
  bv.fill(10000);
  const mixed = mixFrames(a, b, 1, 1);
  const mv = new Int16Array(mixed.buffer, mixed.byteOffset, mixed.byteLength / 2);
  // Without headroom: 20000; with -3dB each ≈ 14142 before soft-limit.
  assert.ok(mv[0] < 20000);
  assert.ok(mv[0] > 10000);
  assert.ok(OVERLAP_GAIN < 1);
});

test('recommendOverlapSec clamps abrupt tails longer than fade-outs', () => {
  assert.ok(recommendOverlapSec('abrupt', 200) > recommendOverlapSec('fade-out', 200));
  assert.equal(recommendOverlapSec('abrupt', 20), 2); // 10% of 20s
});

test('planTransition falls back to gapless only on very low confidence', () => {
  const plan = planTransition(
    { confidence: 0.15, recommendedOverlapSec: 4, durationSec: 180, vocalConfidence: 0.2 },
    { confidence: 0.15 },
  );
  assert.equal(plan.mode, 'gapless');
  assert.equal(plan.fadeSec, 0);
});

test('planTransition uses simple-fade when outgoing analysis is missing', () => {
  const plan = planTransition(null, { confidence: 0.7, bpm: 120 });
  assert.equal(plan.mode, 'simple-fade');
  assert.ok(plan.fadeSec > 0);
  assert.equal(plan.reason, 'missing-outgoing-analysis');
});

test('planTransition uses simple-fade when vocal analysis is not ready', () => {
  const plan = planTransition(
    { confidence: 0.4, recommendedOverlapSec: 4, durationSec: 180, vocalConfidence: 0.2 },
    { confidence: 0.4, bpm: 120 },
  );
  assert.equal(plan.mode, 'simple-fade');
  assert.ok(plan.fadeSec > 0);
  assert.equal(plan.reason, 'analysis-not-ready');
});

test('planTransition crossfades from outgoing vocal window even without incoming analysis', () => {
  const plan = planTransition(
    {
      confidence: 0.8,
      recommendedOverlapSec: 5,
      durationSec: 200,
      vocalConfidence: 0.85,
      lastVocalEndSec: 195,
      tailShape: 'abrupt',
      bpm: 120,
      bpmConfidence: 0.6,
    },
    null,
  );
  assert.equal(plan.mode, 'crossfade');
  assert.equal(plan.baseSwap, true);
  assert.ok(plan.fadeSec >= 3);
  assert.ok(plan.startSec >= 195);
});

test('planTransition uses tail-fade when vocals run to the end', () => {
  const plan = planTransition(
    {
      confidence: 0.8,
      recommendedOverlapSec: 5,
      durationSec: 200,
      vocalConfidence: 0.85,
      lastVocalEndSec: 199.7,
      tailShape: 'abrupt',
      bpm: 120,
      bpmConfidence: 0.6,
    },
    { confidence: 0.8, bpm: 122, bpmConfidence: 0.6 },
  );
  assert.equal(plan.mode, 'tail-fade');
  assert.equal(plan.baseSwap, false);
  assert.ok(plan.fadeSec <= 0.8);
});

test('snapStartToBar does not move start into the vocal region', () => {
  const snapped = snapStartToBar({
    startSec: 10,
    fadeSec: 2,
    lastVocalEndSec: 9.5,
    durationSec: 12,
    bpm: 120,
    allowSnap: true,
  });
  assert.ok(snapped.startSec >= 9.5);
});

test('snapStartToBar aligns to the tail beat grid, not the vocal-end timestamp', () => {
  const snapped = snapStartToBar({
    startSec: 12,
    fadeSec: 4,
    lastVocalEndSec: 8,
    durationSec: 16,
    bpm: 120,
    beatAnchorSec: 0.5,
    allowSnap: true,
  });
  assert.equal(snapped.snapToBeat, true);
  assert.equal(snapped.startSec, 10.5);
});

test('snapStartToBar disables snap when the remaining window is too short', () => {
  const snapped = snapStartToBar({
    startSec: 11.5,
    fadeSec: 0.5,
    lastVocalEndSec: 11.4,
    durationSec: 12,
    bpm: 120,
    allowSnap: true,
  });
  assert.equal(snapped.snapToBeat, false);
});

test('biquad highpass processes a frame without throwing', () => {
  const proc = createBiquadProcessor(designHighpass(48000, 120));
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(1000);
  const out = proc(frame);
  assert.equal(out.length, FRAME_BYTES);
});

async function readFramePaused(mix) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const chunk = mix.read(FRAME_BYTES);
    if (chunk && chunk.length === FRAME_BYTES) return chunk;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return null;
}

test('MixStream startCrossfade mixes then promotes', async () => {
  const mix = new MixStream();
  // Keep the stream paused and pull frames manually so flowing mode cannot
  // drain the outgoing source before startCrossfade attaches.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(8000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 12 }, () => Buffer.from(frame)));
  const incoming = PcmSource.fromBuffers(Array.from({ length: 12 }, () => Buffer.from(frame)));

  let promoted = false;
  mix.on('trackend', (info) => {
    if (info?.promoted) promoted = true;
  });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  assert.ok(await readFramePaused(mix));
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.currentSource != null, true);

  assert.equal(mix.startCrossfade(incoming, { fadeSec: 0.05, curve: 'equal-power', baseSwap: true }), true);

  // 50ms fade / 20ms frames => promote after 3 mixed frames.
  for (let i = 0; i < 5; i++) {
    assert.ok(await readFramePaused(mix));
    if (promoted) break;
  }

  assert.equal(promoted, true);
  mix.endMixer();
});

test('MixStream tail-fade does not consume incoming until promote', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(8000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 12 }, () => Buffer.from(frame)));
  const incomingChunks = Array.from({ length: 12 }, () => Buffer.from(frame));
  incomingChunks[0] = Buffer.alloc(FRAME_BYTES, 7);
  const incoming = PcmSource.fromBuffers(incomingChunks);

  let promoted = false;
  mix.on('trackend', (info) => {
    if (info?.promoted) promoted = true;
  });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.startCrossfade(incoming, {
    fadeSec: 0.06,
    curve: 'equal-power',
    mode: 'tail-fade',
  }), true);

  for (let i = 0; i < 8 && !promoted; i++) {
    assert.ok(await readFramePaused(mix));
  }
  assert.equal(promoted, true);

  const firstIncoming = await readFramePaused(mix);
  assert.ok(firstIncoming);
  assert.equal(firstIncoming[0], 7, 'incoming must start at its first frame after tail-fade');
  mix.endMixer();
});

test('MixStream keeps outgoing audio while incoming has no frames yet', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(8000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 8 }, () => Buffer.from(frame)));
  const incoming = createPendingSource();

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  assert.ok(await readFramePaused(mix));

  const posBefore = mix.positionSec;
  assert.equal(mix.startCrossfade(incoming, { fadeSec: 0.2, curve: 'equal-power' }), true);

  const during = await readFramePaused(mix);
  assert.ok(during);
  assert.ok(mix.positionSec > posBefore, 'outgoing must keep advancing while waiting for incoming');
  assert.equal(mix.isCrossfading, true);
  mix.endMixer();
});

test('MixStream incoming error clears overlap without sourceerror', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 12 }, () => Buffer.from(frame)));
  const incoming = PcmSource.fromBuffers(Array.from({ length: 4 }, () => Buffer.from(frame)));

  let sourceError = false;
  let incomingError = false;
  mix.on('sourceerror', () => { sourceError = true; });
  mix.on('incomingerror', () => { incomingError = true; });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.startCrossfade(incoming, { fadeSec: 0.2, curve: 'equal-power' }), true);

  incoming.emit('error', new Error('incoming ffmpeg failed'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(incomingError, true);
  assert.equal(sourceError, false);
  assert.equal(mix.isCrossfading, false);
  assert.ok(await readFramePaused(mix), 'outgoing track must keep playing after incoming failure');
  mix.endMixer();
});

test('MixStream preserves partial PCM across underruns', async () => {
  const mix = new MixStream();
  const half = Math.floor(FRAME_BYTES / 2);
  const firstHalf = Buffer.alloc(half, 1);
  const secondHalf = Buffer.alloc(FRAME_BYTES - half, 2);

  const source = new EventEmitter();
  source.ended = false;
  source.error = null;
  const queue = [firstHalf];
  source.read = (n) => {
    if (queue.length === 0) return null;
    const chunk = queue.shift();
    return chunk.subarray(0, Math.min(n, chunk.length));
  };
  source.destroy = () => {
    source.removeAllListeners();
    source.ended = true;
  };

  assert.equal(mix.setCurrent(source, { durationSec: 1 }), true);
  // First pull underruns after consuming firstHalf — MixStream emits silence.
  const underrunFrame = await readFramePaused(mix);
  assert.ok(underrunFrame);
  assert.ok([...underrunFrame].every((b) => b === 0));

  queue.push(secondHalf);
  source.emit('data');
  const frame = await readFramePaused(mix);
  assert.ok(frame);
  assert.equal(frame.length, FRAME_BYTES);
  assert.equal(frame[0], 1, 'stashed partial bytes must survive the underrun');
  assert.equal(frame[half], 2);
  mix.endMixer();
});

test('MixStream holds incoming frame when outgoing underruns mid-crossfade', async () => {
  const mix = new MixStream();

  const outgoing = new EventEmitter();
  outgoing.ended = false;
  outgoing.error = null;
  let allowOutgoing = true;
  outgoing.read = (n) => {
    if (!allowOutgoing) return null;
    return Buffer.alloc(Math.min(n, FRAME_BYTES), 4);
  };
  outgoing.destroy = () => {
    outgoing.removeAllListeners();
    outgoing.ended = true;
  };

  const incoming = new EventEmitter();
  incoming.ended = false;
  incoming.error = null;
  let inReads = 0;
  incoming.read = (n) => {
    inReads += 1;
    return Buffer.alloc(Math.min(n, FRAME_BYTES), 5);
  };
  incoming.destroy = () => {
    incoming.removeAllListeners();
    incoming.ended = true;
  };

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  assert.ok(await readFramePaused(mix));

  assert.equal(mix.startCrossfade(incoming, { fadeSec: 0.2, curve: 'equal-power' }), true);
  allowOutgoing = false;
  inReads = 0;

  // Outgoing underruns; incoming frame must be held, not dropped.
  const underrunFrame = await readFramePaused(mix);
  assert.ok(underrunFrame);
  assert.equal(inReads, 1);

  allowOutgoing = true;
  outgoing.emit('data');
  const mixed = await readFramePaused(mix);
  assert.ok(mixed);
  assert.equal(inReads, 1, 'held incoming frame must not be re-read');
  mix.endMixer();
});

test('MixStream snaphandoff adopts prepared next without betweenTracks silence', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(7000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 3 }, () => Buffer.from(frame)));
  const incoming = PcmSource.fromBuffers(Array.from({ length: 4 }, () => Buffer.from(frame)));

  let trackEndCount = 0;
  let adopted = false;
  mix.on('trackend', () => { trackEndCount += 1; });
  mix.on('snaphandoff', ({ adopt }) => {
    adopted = adopt(incoming, { durationSec: 2 });
  });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 60 }), true);
  for (let i = 0; i < 8 && !adopted; i += 1) {
    const chunk = await readFramePaused(mix);
    if (!adopted) assert.ok(chunk, `expected audio frame before handoff (i=${i})`);
  }

  assert.equal(adopted, true);
  assert.equal(trackEndCount, 0);
  assert.equal(mix.currentSource, incoming);
  mix.pause();
  mix.endMixer();
});

test('MixStream rejects late asynchronous snaphandoff adopt', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(5000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 2 }, () => Buffer.from(frame)));
  const lateIncoming = PcmSource.fromBuffers(Array.from({ length: 3 }, () => Buffer.from(frame)));

  let adoptFn = null;
  let trackEndCount = 0;
  mix.on('trackend', () => { trackEndCount += 1; });
  mix.on('snaphandoff', ({ adopt }) => {
    adoptFn = adopt;
    // Intentionally do not adopt synchronously.
  });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 60 }), true);
  for (let i = 0; i < 6 && !adoptFn; i += 1) {
    await readFramePaused(mix);
  }
  assert.ok(adoptFn, 'expected snaphandoff to capture adopt');
  assert.equal(trackEndCount, 1);

  const late = adoptFn(lateIncoming, { durationSec: 2 });
  assert.equal(late, false);
  assert.notEqual(mix.currentSource, lateIncoming);
  mix.endMixer();
});

test('MixStream drains buffered PCM from already-ended adopted source', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(9000);
  const outgoing = PcmSource.fromBuffers([Buffer.from(frame)]);
  const incoming = PcmSource.fromBuffers(Array.from({ length: 3 }, () => Buffer.from(frame)));

  // Fully decode incoming before handoff so ended=true while PCM remains buffered.
  await new Promise((resolve) => {
    if (incoming.ended) return resolve();
    incoming.on('end', resolve);
  });
  assert.equal(incoming.ended, true);
  assert.ok(incoming.available >= FRAME_BYTES);

  let adopted = false;
  mix.on('snaphandoff', ({ adopt }) => {
    adopted = adopt(incoming, { durationSec: 1 });
  });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 60 }), true);
  // First frame is outgoing; next read hits EOF → snap adopt → drain incoming buffer.
  assert.ok(await readFramePaused(mix));
  const firstIncoming = await readFramePaused(mix);
  assert.equal(adopted, true);
  assert.ok(firstIncoming, 'expected buffered frame from ended adopted source');
  assert.equal(firstIncoming.length, FRAME_BYTES);
  mix.endMixer();
});

test('MixStream promoted source errors emit sourceerror', async () => {
  const mix = new MixStream();
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(2000);
  // Short outgoing so promote happens quickly.
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 2 }, () => Buffer.from(frame)));
  const incoming = PcmSource.fromBuffers(Array.from({ length: 8 }, () => Buffer.from(frame)));

  let sourceError = false;
  mix.on('sourceerror', () => { sourceError = true; });

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.startCrossfade(incoming, { fadeSec: 0.04, curve: 'equal-power' }), true);

  for (let i = 0; i < 8; i++) {
    await readFramePaused(mix);
    if (!mix.isCrossfading) break;
  }

  incoming.emit('error', new Error('promoted decode failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sourceError, true);
  mix.endMixer();
});

test('blendFrame interpolates linearly and returns the endpoints unchanged', () => {
  const dry = Buffer.alloc(FRAME_BYTES);
  const wet = Buffer.alloc(FRAME_BYTES);
  new Int16Array(dry.buffer).fill(10000);
  new Int16Array(wet.buffer).fill(-10000);

  assert.equal(blendFrame(dry, wet, 0), dry);
  assert.equal(blendFrame(dry, wet, 1), wet);

  const half = blendFrame(dry, wet, 0.5);
  const view = new Int16Array(half.buffer, half.byteOffset, half.byteLength / 2);
  assert.equal(view[0], 0);
});

test('MixStream beatmix mode ramps the bass-swap EQ in over swapBar instead of applying it instantly', async () => {
  const mix = new MixStream();
  const loud = Buffer.alloc(FRAME_BYTES);
  new Int16Array(loud.buffer).fill(8000);
  const silent = Buffer.alloc(FRAME_BYTES);
  // Long fadeSec relative to swapSec (1 bar @120BPM = 2s) keeps the overall
  // equal-power crossfade gain ~flat across the sampled frames, isolating
  // the EQ ramp's effect from the (separate, unchanged) gain envelope.
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 200 }, () => Buffer.from(loud)));
  const incoming = PcmSource.fromBuffers(Array.from({ length: 200 }, () => Buffer.from(silent)));

  assert.equal(mix.setCurrent(outgoing, { durationSec: 200 }), true);
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.startCrossfade(incoming, {
    mode: 'beatmix',
    fadeSec: 80,
    curve: 'equal-power',
    baseSwap: true,
    highpassHz: 120,
    targetBpm: 120,
    sync: { bars: 40, beatsPerBar: 4 },
    eq: { type: 'bass-swap', swapBar: 1, highpassHz: 120 },
  }), true);

  const first = await readFramePaused(mix);
  const firstView = new Int16Array(first.buffer, first.byteOffset, first.byteLength / 2);
  const firstAbs = Math.max(...Array.from(firstView, Math.abs));

  // 1 bar @120BPM = 2s = 100 frames; sample well past that.
  let later;
  for (let i = 0; i < 125; i++) {
    later = await readFramePaused(mix);
  }
  const laterView = new Int16Array(later.buffer, later.byteOffset, later.byteLength / 2);
  const laterAbs = Math.max(...Array.from(laterView, Math.abs));

  assert.ok(
    firstAbs > laterAbs * 3,
    `expected the bass swap to ramp in (first=${firstAbs}, later=${laterAbs})`,
  );
  mix.endMixer();
});

test('MixStream non-beatmix crossfade applies base-swap EQ fully on the very first frame (no bar-envelope ramp)', async () => {
  // computeEqRampSec() returns null for any plan.mode other than 'beatmix',
  // so #readCrossfadeFrame's blend mix resolves eqRampSec == null to 1
  // immediately — legacy crossfade/phrase-crossfade should be bit-identical
  // to running the highpass directly, with no dry/wet ramp-in at all.
  // Verified against an independent instance of the same filter (both start
  // from the same zero IIR state on this, the very first frame) rather than
  // a magnitude threshold — the filter's own step-response transient makes
  // "how loud is frame 1" alone an unreliable, ramp-vs-no-ramp signal.
  const mix = new MixStream();
  const loud = Buffer.alloc(FRAME_BYTES);
  new Int16Array(loud.buffer).fill(8000);
  const silent = Buffer.alloc(FRAME_BYTES);
  const outgoing = PcmSource.fromBuffers([Buffer.from(loud)]);
  const incoming = PcmSource.fromBuffers([Buffer.from(silent)]);

  assert.equal(mix.setCurrent(outgoing, { durationSec: 60 }), true);
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.startCrossfade(incoming, { fadeSec: 5, curve: 'equal-power', baseSwap: true, highpassHz: 120 }), true);

  const frame = await readFramePaused(mix);
  assert.ok(frame);

  const expectedWet = createBiquadProcessor(designHighpass(48000, 120))(Buffer.from(loud));
  const outGain = gainForPosition({ positionSec: 0, fadeSec: 5, curve: 'equal-power', role: 'out' });
  const inGain = gainForPosition({ positionSec: 0, fadeSec: 5, curve: 'equal-power', role: 'in' });
  const expected = mixFrames(expectedWet, silent, outGain, inGain);

  assert.deepEqual(frame, expected);
  mix.endMixer();
});

test('MixStream tail-fade soft-limits near-full-scale input with a gentle knee (not a hard clamp)', async () => {
  const mix = new MixStream();
  const loud = Buffer.alloc(FRAME_BYTES);
  const loudView = new Int16Array(loud.buffer);
  loudView.fill(32000);
  const outgoing = PcmSource.fromBuffers(Array.from({ length: 5 }, () => Buffer.from(loud)));
  const incoming = PcmSource.fromBuffers(Array.from({ length: 5 }, () => Buffer.from(loud)));

  assert.equal(mix.setCurrent(outgoing, { durationSec: 1 }), true);
  // Prime: a Readable queues one frame from _read() before any source is
  // attached (an all-zero silence frame) — without draining it first, the
  // very next read() returns that stale silence instead of a real tail-fade
  // frame, and a peak-only-upper-bound assertion would pass on it vacuously.
  assert.ok(await readFramePaused(mix));
  assert.equal(mix.startCrossfade(incoming, { fadeSec: 5, curve: 'equal-power', mode: 'tail-fade' }), true);

  const frame = await readFramePaused(mix);
  const view = new Int16Array(frame.buffer, frame.byteOffset, frame.byteLength / 2);
  const peak = Math.max(...Array.from(view, Math.abs));
  // outGain ~1 at the very start of the fade: 32000 sits above the ~31130
  // (0.95 ceiling) threshold, so the soft-knee limiter engages — but only
  // gently (tanh saturation), not the old aggressive whole-range cubic curve.
  assert.ok(peak < 32000, `expected the limiter to engage at all, got peak ${peak}`);
  assert.ok(peak > 31000, `expected a gentle knee near the ceiling, not heavy compression, got peak ${peak}`);
  mix.endMixer();
});

test('softLimitFrame is continuous across the ceiling threshold (no discontinuity)', () => {
  // Round-2 regression: an earlier version switched abruptly from unity to
  // the cubic curve exactly at the ceiling, so a sample of 31129 stayed
  // unchanged while 31130 jumped to ~21764 — audible as a click whenever a
  // waveform hovers near the threshold.
  const frame = Buffer.alloc(FRAME_BYTES);
  const view = new Int16Array(frame.buffer);
  view[0] = 31129;
  view[1] = 31130;
  softLimitFrame(frame, 0.95);
  assert.ok(
    Math.abs(view[0] - view[1]) <= 2,
    `expected adjacent inputs straddling the threshold to stay adjacent after limiting, got ${view[0]} vs ${view[1]}`,
  );
});
