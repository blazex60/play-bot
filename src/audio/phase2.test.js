import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gainForPosition, mixFrames, FRAME_BYTES, OVERLAP_GAIN } from './fade.js';
import { planTransition } from './transition.js';
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

test('planTransition uses simple-fade for medium confidence', () => {
  const plan = planTransition(
    { confidence: 0.4, recommendedOverlapSec: 4, durationSec: 180, vocalConfidence: 0.2 },
    { confidence: 0.4, bpm: 120 },
  );
  assert.equal(plan.mode, 'simple-fade');
  assert.ok(plan.fadeSec > 0);
});

test('planTransition uses simple-fade when incoming analysis is missing', () => {
  const plan = planTransition(
    {
      confidence: 0.7,
      recommendedOverlapSec: 4,
      durationSec: 180,
      vocalConfidence: 0.6,
      bpm: 120,
    },
    null,
  );
  assert.equal(plan.mode, 'simple-fade');
  assert.ok(plan.fadeSec > 0);
  assert.equal(plan.baseSwap, false);
  assert.equal(plan.reason, 'missing-incoming-analysis');
});

test('planTransition clamps vocal-weak overlaps to 2s', () => {
  const plan = planTransition(
    {
      confidence: 0.7,
      recommendedOverlapSec: 5,
      durationSec: 200,
      vocalConfidence: 0.2,
      bpm: 120,
    },
    { confidence: 0.7, bpm: 122 },
  );
  assert.equal(plan.mode, 'crossfade');
  assert.ok(plan.fadeSec <= 2);
  assert.equal(plan.baseSwap, true);
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
