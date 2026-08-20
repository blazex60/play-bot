import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
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

function pcmView(chunk) {
  return new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
}

function pcmContains(chunks, value) {
  for (const chunk of chunks) {
    const view = pcmView(chunk);
    for (let i = 0; i < view.length; i++) {
      if (view[i] === value) return true;
    }
  }
  return false;
}

function previewFrameSamples(chunks, max = 8) {
  const out = [];
  const step = FRAME_BYTES / 2;
  for (const chunk of chunks) {
    const view = pcmView(chunk);
    for (let i = 0; i < view.length && out.length < max; i += step) {
      out.push(view[i]);
    }
    if (out.length >= max) break;
  }
  return out;
}

async function waitForPcm(chunks, value, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!pcmContains(chunks, value) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fillFrame(value) {
  const buf = Buffer.alloc(FRAME_BYTES);
  pcmView(buf).fill(value);
  return buf;
}

test('MixStream pushes gapless frames from a PCM source', async () => {
  const mix = new MixStream();
  try {
    const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 3)]);
    mix.setCurrent(source);

    const frames = await collectFrames(mix, 3);
    assert.equal(frames.length, 3);
    assert.equal(frames[0].length, FRAME_BYTES);
  } finally {
    mix.endMixer();
  }
});

test('MixStream emits trackend when the current source ends', async () => {
  const mix = new MixStream();
  try {
    const source = PcmSource.fromBuffers([silence(FRAME_BYTES)]);
    let ended = false;
    mix.on('trackend', () => { ended = true; });
    mix.setCurrent(source);

    await collectFrames(mix, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, true);
  } finally {
    mix.endMixer();
  }
});

test('MixStream dropCurrent emits trackend immediately', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 10)]);
  let ended = false;
  mix.on('trackend', () => { ended = true; });
  mix.setCurrent(source);
  mix.dropCurrent();
  assert.equal(ended, true);
  mix.endMixer();
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
    else await new Promise(resolve => setTimeout(resolve, FRAME_MS));
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
  try {
    const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 5)]);
    mix.setCurrent(source);
    await collectFrames(mix, 2);
    assert.ok(mix.positionSec > 0);
  } finally {
    mix.endMixer();
  }
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

  try {
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
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream delivers PCM after a flowing consumer attaches before setCurrent', async () => {
  const mix = new MixStream();
  const sink = new PassThrough();
  const received = [];
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)));
  mix.pipe(sink);

  try {
    await new Promise((resolve) => setImmediate(resolve));

    mix.setCurrent(PcmSource.fromBuffers([fillFrame(1234), fillFrame(1234)]));

    // fromBuffers appends in a microtask, so MixStream may emit a brief
    // silence frame first (same as production waiting on ffmpeg). Pipe
    // backpressure can also coalesce later PCM into a chunk that does not
    // start with the tone — scan the whole buffer rather than sample[0].
    await waitForPcm(received, 1234);
    assert.ok(pcmContains(received, 1234), `expected real PCM after leading silence, got ${previewFrameSamples(received)}`);
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream setCurrent after a flowing between-tracks gap delivers the next track', async () => {
  const mix = new MixStream();
  const sink = new PassThrough();
  const received = [];
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)));
  mix.pipe(sink);

  try {
    const ended = new Promise((resolve) => mix.once('trackend', resolve));
    mix.setCurrent(PcmSource.fromBuffers([fillFrame(111)]));
    await ended;

    mix.setCurrent(PcmSource.fromBuffers([fillFrame(2222), fillFrame(2222)]));
    await waitForPcm(received, 2222);
    assert.ok(pcmContains(received, 2222), `expected next-track PCM after the flowing gap, got ${previewFrameSamples(received)}`);
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream paces flowing between-track silence in real time', async () => {
  const mix = new MixStream();
  const frameTimes = [];
  mix.on('data', () => frameTimes.push(Date.now()));

  try {
    mix.dropCurrent();
    const deadline = Date.now() + 500;
    while (frameTimes.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(frameTimes.length >= 4, true, 'expected four keep-alive frames');
    assert.ok(frameTimes[3] - frameTimes[0] >= 45,
      `four 20 ms frames were emitted too quickly: ${frameTimes[3] - frameTimes[0]}ms`);
  } finally {
    mix.endMixer();
  }
});

test('MixStream does not override downstream backpressure for between-track silence', async () => {
  const mix = new MixStream();
  let releaseWrite;
  const blocked = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      releaseWrite = callback;
    },
  });
  mix.pipe(blocked);

  try {
    mix.dropCurrent();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(blocked.writableLength <= FRAME_BYTES,
      `backpressured sink buffered ${blocked.writableLength} bytes of silence`);
    // At most one frame per 20 ms may accumulate while the sink is blocked;
    // allow one scheduling frame of jitter on top of the five due in 100 ms.
    assert.ok(mix.readableLength <= FRAME_BYTES * 6,
      `mixer buffered ${mix.readableLength} bytes of silence`);
  } finally {
    mix.unpipe(blocked);
    releaseWrite?.();
    blocked.destroy();
    mix.endMixer();
  }
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
