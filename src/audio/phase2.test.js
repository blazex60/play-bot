import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gainForPosition, mixFrames, FRAME_BYTES, OVERLAP_GAIN } from './fade.js';
import { planTransition } from './transition.js';
import { recommendOverlapSec } from './trackAnalysis.js';
import { designHighpass, createBiquadProcessor } from './eq.js';
import { MixStream } from './mixStream.js';
import { PcmSource } from './pcmSource.js';

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

test('planTransition falls back to gapless on low confidence', () => {
  const plan = planTransition(
    { confidence: 0.2, recommendedOverlapSec: 4, durationSec: 180, vocalConfidence: 0.2 },
    { confidence: 0.2 },
  );
  assert.equal(plan.mode, 'gapless');
  assert.equal(plan.fadeSec, 0);
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
