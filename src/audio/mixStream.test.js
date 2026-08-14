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

test('MixStream pushes silence between tracks so the player is not starved', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES)]);
  mix.setCurrent(source);

  // Use paused reads (like @discordjs/voice) — flowing 'data' mode would
  // spin forever on continuous between-track silence.
  const first = await new Promise((resolve) => {
    const tryRead = () => {
      const chunk = mix.read(FRAME_BYTES);
      if (chunk) return resolve(chunk);
      setImmediate(tryRead);
    };
    tryRead();
  });
  assert.equal(first.length, FRAME_BYTES);

  await new Promise(resolve => setImmediate(resolve));

  let silenceFrames = 0;
  for (let i = 0; i < 20 && silenceFrames < 3; i++) {
    const chunk = mix.read(FRAME_BYTES);
    if (chunk) silenceFrames += 1;
    else await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(silenceFrames >= 3, 'expected silence frames during between-tracks handoff');
  mix.endMixer();
});

test('MixStream.isDestroyed is true after endMixer', () => {
  const mix = new MixStream();
  assert.equal(mix.isDestroyed(), false);
  mix.endMixer();
  assert.equal(mix.isDestroyed(), true);
});

test('MixStream reports playback position in seconds', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 5)]);
  mix.setCurrent(source);
  await collectFrames(mix, 2);
  assert.ok(mix.positionSec > 0);
});

test('MixStream emits underrunClear only after recovering from underrun', async () => {
  const mix = new MixStream();
  let clears = 0;
  mix.on('underrunClear', () => { clears += 1; });
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 3)]);
  mix.setCurrent(source);
  await collectFrames(mix, 3);
  assert.equal(clears, 0, 'healthy frames must not clear another guild underrun');
  mix.endMixer();
});
