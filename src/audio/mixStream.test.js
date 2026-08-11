import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_BYTES } from './fade.js';
import { MixStream } from './mixStream.js';
import { PcmSource } from './pcmSource.js';

function silence(bytes) {
  return Buffer.alloc(bytes);
}

function collectFrames(stream, count) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const onData = (chunk) => {
      frames.push(chunk);
      if (frames.length >= count) {
        stream.off('data', onData);
        resolve(frames);
      }
    };
    stream.on('data', onData);
    stream.on('error', reject);
    stream.on('end', () => {
      stream.off('data', onData);
      resolve(frames);
    });
  });
}

test('MixStream pushes gapless frames from a PCM source', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 3)]);
  mix.setCurrent(source);

  const frames = await collectFrames(mix, 3);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].length, FRAME_BYTES);
});

test('MixStream emits trackend when the current source ends', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES)]);
  let ended = false;
  mix.on('trackend', () => { ended = true; });
  mix.setCurrent(source);

  await collectFrames(mix, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, true);
});

test('MixStream dropCurrent emits trackend immediately', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 10)]);
  let ended = false;
  mix.on('trackend', () => { ended = true; });
  mix.setCurrent(source);
  mix.dropCurrent();
  assert.equal(ended, true);
});

test('MixStream reports playback position in seconds', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 5)]);
  mix.setCurrent(source);
  await collectFrames(mix, 2);
  assert.ok(mix.positionSec > 0);
});
