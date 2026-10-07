import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FRAME_BYTES, SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE } from '../audio/fade.js';
import { createWavSink, createSink } from './sinks.js';

test('wav sink writes a valid RIFF/WAVE header and patches sizes on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-sink-'));
  const file = join(dir, 'out.wav');
  try {
    const sink = createWavSink(file);
    const frames = 50;
    for (let i = 0; i < frames; i += 1) sink.write(Buffer.alloc(FRAME_BYTES, i % 128));
    await sink.close();
    const data = await readFile(file);
    const dataBytes = frames * FRAME_BYTES;
    assert.equal(data.length, 44 + dataBytes);
    assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    assert.equal(data.toString('ascii', 8, 12), 'WAVE');
    assert.equal(data.readUInt32LE(4), 36 + dataBytes);
    assert.equal(data.readUInt16LE(20), 1, 'PCM format tag');
    assert.equal(data.readUInt16LE(22), CHANNELS);
    assert.equal(data.readUInt32LE(24), SAMPLE_RATE);
    assert.equal(data.readUInt32LE(28), SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
    assert.equal(data.toString('ascii', 36, 40), 'data');
    assert.equal(data.readUInt32LE(40), dataBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createSink validates arguments', async () => {
  await assert.rejects(() => createSink({ sink: 'wav' }), /--out/);
  await assert.rejects(() => createSink({ sink: 'bogus' }), /不明な sink/);
});

test('sink write() does not crash after the child process exits early', async () => {
  // ffplay/aplay exiting (e.g. no audio device) makes stdin writes fail with
  // EPIPE/ERR_STREAM_DESTROYED — handled, not thrown.
  const sink = await createSink({ sink: 'ffplay' });
  await sink.close();
  assert.doesNotThrow(() => { sink.write(Buffer.alloc(FRAME_BYTES)); });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(sink.write(Buffer.alloc(FRAME_BYTES)), false);
});
