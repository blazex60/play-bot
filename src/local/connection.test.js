import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { FRAME_BYTES } from '../audio/fade.js';
import { LocalVoiceConnection, createOpusDecoder } from './connection.js';

function memorySink() {
  const chunks = [];
  return {
    name: 'memory',
    chunks,
    write(buf) { chunks.push(Buffer.from(buf)); return true; },
    async close() {},
    get bytes() { return chunks.reduce((n, c) => n + c.length, 0); },
  };
}

/** Readable that emits silence PCM frames forever (until destroyed). */
function endlessPcm() {
  return new Readable({
    read() {
      this.push(Buffer.alloc(FRAME_BYTES));
    },
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('LocalVoiceConnection plays a real AudioPlayer resource into the sink', async () => {
  const decode = await createOpusDecoder();
  const sink = memorySink();
  const connection = new LocalVoiceConnection({ sink, decode });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  try {
    const subscription = connection.subscribe(player);
    assert.ok(subscription, 'subscribe() should return a PlayerSubscription');
    assert.equal(connection.state.subscription, subscription);
    // playable gates on connection.state.status === 'ready'
    assert.deepEqual(player.playable, [connection]);

    const resource = createAudioResource(endlessPcm(), {
      inputType: StreamType.Raw,
      silencePaddingFrames: 0,
    });
    player.play(resource);
    await sleep(300);
    assert.ok(
      sink.bytes >= FRAME_BYTES,
      `expected decoded PCM in sink, got ${sink.bytes} bytes`,
    );
    assert.equal(sink.bytes % FRAME_BYTES, 0, 'sink should receive whole s16le frames');
    assert.ok(connection.packetsWritten > 0);
  } finally {
    connection.destroy();
    player.stop(true);
  }
  assert.equal(connection.state.status, VoiceConnectionStatus.Destroyed);
  assert.equal(player.playable.length, 0, 'destroyed connection leaves the playable list');
});

test('dispatchAudio ignores ticks with no prepared packet and bad frames', async () => {
  const sink = memorySink();
  const connection = new LocalVoiceConnection({ sink, decode: (p) => Buffer.alloc(FRAME_BYTES) });
  connection.dispatchAudio();
  assert.equal(sink.bytes, 0);
  connection.prepareAudioPacket(Buffer.from([0xde, 0xad]));
  connection.dispatchAudio();
  assert.equal(sink.bytes, FRAME_BYTES);
  // throwing decoder must not crash the tick path
  const failing = new LocalVoiceConnection({ sink, decode: () => { throw new Error('bad packet'); } });
  failing.prepareAudioPacket(Buffer.from([0x00]));
  failing.dispatchAudio();
  connection.destroy();
  failing.destroy();
});

test('prepareAudioPacket/dispatchAudio stop once destroyed', async () => {
  const sink = memorySink();
  const connection = new LocalVoiceConnection({ sink, decode: (p) => Buffer.alloc(4) });
  connection.destroy();
  connection.prepareAudioPacket(Buffer.from([1]));
  connection.dispatchAudio();
  assert.equal(sink.bytes, 0);
});

test('re-subscribing returns the existing subscription', async () => {
  const sink = memorySink();
  const connection = new LocalVoiceConnection({ sink, decode: (p) => p });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  try {
    const first = connection.subscribe(player);
    const second = connection.subscribe(player);
    assert.equal(first, second);
    assert.equal(player.subscribers?.length ?? -1, 1);
  } finally {
    connection.destroy();
    player.stop(true);
  }
});

test('destroy emits stateChange with Destroyed status', async () => {
  const connection = new LocalVoiceConnection({ sink: memorySink(), decode: (p) => p });
  const events = [];
  connection.on('stateChange', (oldState, newState) => events.push(newState.status));
  connection.destroy();
  assert.deepEqual(events, [VoiceConnectionStatus.Destroyed]);
});
