import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlayerStatus } from '@discordjs/voice';
import { LoopMode, createTrack } from './queue.js';
import { isShortTrack, shouldReconnectRetry } from './player/playbackPolicy.js';
import { triggerTrackEnd } from './player/playbackDrive.js';
import { makeAudioPlayer, makePlayer, nextTurn } from './player/test-helpers.js';
import { FRAME_BYTES } from './audio/fade.js';
import { PcmSource } from './audio/pcmSource.js';

test('playbackPolicy: isShortTrack is true when duration is under 5 seconds', () => {
  assert.equal(isShortTrack({ duration: 4 }), true);
  assert.equal(isShortTrack({ duration: 5 }), false);
  assert.equal(isShortTrack({ duration: null }), false);
  assert.equal(isShortTrack(null), false);
});

test('playbackPolicy: shouldReconnectRetry skips short tracks and errors', () => {
  const longTrack = { duration: 60 };
  const shortTrack = { duration: 3 };

  assert.equal(shouldReconnectRetry({ elapsedMs: 1000, track: longTrack, hadError: false }), true);
  assert.equal(shouldReconnectRetry({ elapsedMs: 1000, track: shortTrack, hadError: false }), false);
  assert.equal(shouldReconnectRetry({ elapsedMs: 1000, track: longTrack, hadError: true }), false);
  assert.equal(shouldReconnectRetry({ elapsedMs: 6000, track: longTrack, hadError: false }), false);
});

test('acceptance: stream error automatically skips an unplayable track', async () => {
  const { player, audioPlayer, resources, queue } = makePlayer();
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
  }));

  await player.playNext();
  audioPlayer.events.get('error')(new Error('Private video'));

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queue.current.title, 'Track B');
  assert.equal(audioPlayer.resource, resources[1]);

  await player.stop();
});

test('acceptance: error during an active handoff advances once it finishes', async () => {
  const audioPlayer = makeAudioPlayer();
  const originalPlay = audioPlayer.play;
  let failNextTrack = false;
  let resolveTrackCPlayed;
  const trackCPlayed = new Promise(resolve => { resolveTrackCPlayed = resolve; });
  audioPlayer.play = function (resource) {
    originalPlay.call(this, resource);
    if (failNextTrack) {
      failNextTrack = false;
      this.events.get('error')(new Error('Private video'));
    }
    if (resource.stream.url === 'https://example.com/c') resolveTrackCPlayed();
  };

  let exhaustedCalls = 0;
  let disconnected = false;
  const { player, resources, queue } = makePlayer({
    audioPlayer,
    trackDuration: 3,
    handleQueueExhausted: async () => { exhaustedCalls += 1; return false; },
    onDisconnect: async () => { disconnected = true },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60 }));
  queue.add(createTrack({ title: 'Track D', webpageUrl: 'https://example.com/d', duration: 60 }));

  await player.playNext();
  failNextTrack = true;
  triggerTrackEnd({ audioPlayer });

  await trackCPlayed;
  await nextTurn();
  assert.equal(queue.current.title, 'Track C');
  assert.equal(resources.length, 3);
  assert.equal(exhaustedCalls, 0);
  assert.equal(disconnected, false);

  await player.stop();
});

test('acceptance: error while replaying a looped track advances past it', async () => {
  const audioPlayer = makeAudioPlayer();
  const originalPlay = audioPlayer.play;
  let failReplay = false;
  let resolveTrackBPlayed;
  const trackBPlayed = new Promise(resolve => { resolveTrackBPlayed = resolve });
  audioPlayer.play = function (resource) {
    originalPlay.call(this, resource);
    if (failReplay) {
      failReplay = false;
      this.events.get('error')(new Error('Private video'));
    }
    if (resource.stream.url === 'https://example.com/b') resolveTrackBPlayed();
  };

  const { player, audioPlayer: playerAudio, queue } = makePlayer({ audioPlayer, trackDuration: 3 });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }));
  queue.loopMode = LoopMode.TRACK;

  await player.playNext();
  failReplay = true;
  triggerTrackEnd({ audioPlayer: playerAudio });

  await trackBPlayed;
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');

  await player.stop();
});

test('acceptance: queue exhaustion with no handler disconnects', async () => {
  let disconnected = false;
  const { player, audioPlayer } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true },
  });

  await player.playNext();
  triggerTrackEnd({ audioPlayer });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disconnected, true);
});

test('acceptance: handleQueueExhausted returning true skips disconnect', async () => {
  let disconnected = false;
  let handledCalled = false;
  const { player, audioPlayer } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true },
    handleQueueExhausted: async (finishedTrack) => {
      handledCalled = true;
      assert.equal(finishedTrack.title, 'Track A');
      return true;
    },
  });

  await player.playNext();
  triggerTrackEnd({ audioPlayer });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(handledCalled, true);
  assert.equal(disconnected, false);
});

test('acceptance: handleQueueExhausted throwing falls back to disconnect', async () => {
  let disconnected = false;
  const { player, audioPlayer } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true },
    handleQueueExhausted: async () => { throw new Error('boom'); },
  });

  await player.playNext();
  triggerTrackEnd({ audioPlayer });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disconnected, true);
});

test('acceptance: QUEUE loop returns to the first track after the last', async () => {
  const { player, audioPlayer, queue } = makePlayer({ trackDuration: 3 });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 3 }));
  queue.loopMode = LoopMode.QUEUE;

  await player.playNext();
  triggerTrackEnd({ audioPlayer });
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');

  triggerTrackEnd({ audioPlayer });
  await nextTurn();
  assert.equal(queue.current.title, 'Track A');

  await player.stop();
});

test('acceptance: short tracks do not trigger reconnect retry', async () => {
  let disconnected = false;
  const { player, audioPlayer } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true },
  });

  await player.playNext();
  triggerTrackEnd({ audioPlayer });

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(disconnected, true);
});

test('acceptance: recordPlay is called for tracks with a requester id', async () => {
  const calls = [];
  const track = createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    requestedBy: 'display-name',
    requestedById: 'discord-123',
    videoId: 'vid-1',
    channel: 'Channel A',
  });
  const { player } = makePlayer({
    recordPlayFn: async (payload) => { calls.push(payload); },
    track,
  });

  await player.playNext();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    guildId: 'guild-1',
    discordUserId: 'discord-123',
    username: 'display-name',
    trackTitle: 'Track A',
    trackUrl: 'https://example.com/a',
    videoId: 'vid-1',
    channel: 'Channel A',
  });

  await player.stop();
});

test('acceptance: recordPlay is skipped for autoplay tracks', async () => {
  const calls = [];
  const track = createTrack({
    title: 'Autoplay Track',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    requestedBy: '🔀 自動再生',
    requestedById: null,
  });
  const { player } = makePlayer({
    recordPlayFn: async (payload) => { calls.push(payload); },
    track,
  });

  await player.playNext();
  assert.equal(calls.length, 0);
  await player.stop();
});

test('acceptance: onTrackStart is called even for autoplay tracks', async () => {
  const calls = [];
  const track = createTrack({
    title: 'Autoplay Track',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    requestedBy: '🔀 自動再生',
    requestedById: null,
    videoId: 'vid-2',
  });
  const { player } = makePlayer({
    onTrackStart: (videoId) => calls.push(videoId),
    track,
  });

  await player.playNext();
  assert.deepEqual(calls, ['vid-2']);
  await player.stop();
});

test('acceptance: rejecting recordPlayFn does not break playback', async () => {
  const recordPlayFn = async () => { throw new Error('web api down'); };
  const track = createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    requestedById: 'discord-123',
  });
  const { player, audioPlayer } = makePlayer({ recordPlayFn, track });

  await player.playNext();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing);

  await player.stop();
});

test('acceptance (mixer): gapless playback advances through trackend', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let createCount = 0;
  const { player, audioPlayer, queue } = makePlayer({
    mixerEnabled: true,
    trackDuration: 3,
    createPcmSourceFn: async () => {
      createCount += 1;
      return PcmSource.fromBuffers([frame]);
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 3 }));

  await player.playNext();
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing);
  triggerTrackEnd({ mixStream: player.mixStream });
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');
  assert.equal(createCount, 2);

  await player.stop();
});

test('acceptance (mixer): skip advances to the next track', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  const { player, queue } = makePlayer({
    mixerEnabled: true,
    trackDuration: 60,
    createPcmSourceFn: async () => PcmSource.fromBuffers([frame, frame, frame]),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }));

  await player.playNext();
  await player.skip();
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');

  await player.stop();
});
