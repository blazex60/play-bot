import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FRAME_BYTES } from './fade.js';
import { MixStream } from './mixStream.js';
import { PcmSource } from './pcmSource.js';
import { MAX_UNDERRUN_MS } from './config.js';

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

test('MixStream waiting for the first source does not fire the underrun watchdog', async () => {
  // createAudioResource(StreamType.Raw) pipelines MixStream into an opus
  // encoder immediately, before GuildPlayer.setCurrent. That pull used to
  // count as an underrun: after MAX_UNDERRUN_MS the mixer emitted
  // sourceerror, raced the real PCM source, and Discord transmitted
  // silence (speaking indicator) with no track playing.
  const mix = new MixStream();
  const errors = [];
  mix.on('sourceerror', (err) => errors.push(err.message));

  const sink = new PassThrough();
  sink.resume();
  mix.pipe(sink);

  await new Promise((resolve) => setImmediate(resolve));
  const start = Date.now();
  const originalNow = Date.now;
  Date.now = () => start + MAX_UNDERRUN_MS + 1_000;
  try {
    mix.read();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(errors, []);
  mix.unpipe(sink);
  mix.endMixer();
});

test('MixStream delivers PCM after a flowing consumer attaches before setCurrent', async () => {
  const mix = new MixStream();
  const sink = new PassThrough();
  const received = [];
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)));
  mix.pipe(sink);

  await new Promise((resolve) => setImmediate(resolve));

  const tone = Buffer.alloc(FRAME_BYTES);
  new Int16Array(tone.buffer).fill(1234);
  mix.setCurrent(PcmSource.fromBuffers([Buffer.from(tone), Buffer.from(tone)]));

  const deadline = Date.now() + 1000;
  while (Buffer.concat(received).length < FRAME_BYTES && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const pcm = Buffer.concat(received).subarray(0, FRAME_BYTES);
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, FRAME_BYTES / 2);
  assert.equal(view[0], 1234, 'expected real PCM, not the silence the pipeline used to consume');
  mix.unpipe(sink);
  mix.endMixer();
});

test('MixStream setCurrent after a flowing between-tracks gap delivers the next track', async () => {
  const mix = new MixStream();
  const first = Buffer.alloc(FRAME_BYTES);
  new Int16Array(first.buffer).fill(111);
  const second = Buffer.alloc(FRAME_BYTES);
  new Int16Array(second.buffer).fill(2222);

  const sink = new PassThrough();
  const samples = [];
  sink.on('data', (chunk) => {
    const view = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
    if (view.length > 0) samples.push(view[0]);
  });
  mix.pipe(sink);

  const ended = new Promise((resolve) => mix.once('trackend', resolve));
  mix.setCurrent(PcmSource.fromBuffers([Buffer.from(first)]));
  await ended;

  mix.setCurrent(PcmSource.fromBuffers([Buffer.from(second), Buffer.from(second)]));
  const deadline = Date.now() + 1000;
  while (!samples.includes(2222) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.ok(samples.includes(2222), `expected next-track PCM after the flowing gap, got ${samples.slice(0, 8)}`);
  mix.unpipe(sink);
  mix.endMixer();
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
