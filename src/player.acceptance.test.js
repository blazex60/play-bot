import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AudioPlayerStatus } from '@discordjs/voice';
import { LoopMode, createTrack } from './queue.js';
import { isShortTrack, shouldReconnectRetry } from './player/playbackPolicy.js';
import { triggerTrackEnd } from './player/playbackDrive.js';
import { makePlayer, nextTurn } from './player/test-helpers.js';
import { FRAME_BYTES } from './audio/fade.js';
import { PcmSource } from './audio/pcmSource.js';
import { ANALYSIS_VERSION } from './audio/trackAnalysis.js';
import {
  configureSettingsPathForTest,
  getSettingsPathForTest,
  setFade,
} from './settings.js';

const silentFrame = Buffer.alloc(FRAME_BYTES);

async function waitMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const { player, queue } = makePlayer({
    createPcmSourceFn: async () => PcmSource.fromBuffers([silentFrame]),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
  }));

  await player.playNext();
  player.mixStream.emit('sourceerror', new Error('Private video'));
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');

  await player.stop();
});

test('acceptance: pcm source failure during handoff advances to the next track', async () => {
  let exhaustedCalls = 0;
  let disconnected = false;
  const { player, queue } = makePlayer({
    trackDuration: 3,
    handleQueueExhausted: async () => { exhaustedCalls += 1; return false; },
    onDisconnect: async () => { disconnected = true; },
    createPcmSourceFn: async (track) => {
      if (track.title === 'Track B') throw new Error('Private video');
      return PcmSource.fromBuffers([silentFrame]);
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60 }));
  queue.add(createTrack({ title: 'Track D', webpageUrl: 'https://example.com/d', duration: 60 }));

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });
  await waitMs(40);
  assert.equal(queue.current.title, 'Track C');
  assert.equal(exhaustedCalls, 0);
  assert.equal(disconnected, false);

  await player.stop();
});

test('acceptance: error while replaying a looped track advances past it', async () => {
  const { player, queue } = makePlayer({
    trackDuration: 3,
    createPcmSourceFn: async () => PcmSource.fromBuffers([silentFrame, silentFrame]),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }));
  queue.loopMode = LoopMode.TRACK;

  await player.playNext();
  player.mixStream.emit('sourceerror', new Error('Private video'));
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');

  await player.stop();
});

test('acceptance: queue exhaustion with no handler disconnects', async () => {
  let disconnected = false;
  const { player } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true; },
  });

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });

  await waitMs(20);
  assert.equal(disconnected, true);
});

test('acceptance: handleQueueExhausted returning true skips disconnect', async () => {
  let disconnected = false;
  let handledCalled = false;
  const { player } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true; },
    handleQueueExhausted: async (finishedTrack) => {
      handledCalled = true;
      assert.equal(finishedTrack.title, 'Track A');
      return true;
    },
  });

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });

  await waitMs(20);
  assert.equal(handledCalled, true);
  assert.equal(disconnected, false);
});

test('acceptance: handleQueueExhausted throwing falls back to disconnect', async () => {
  let disconnected = false;
  const { player } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true; },
    handleQueueExhausted: async () => { throw new Error('boom'); },
  });

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });

  await waitMs(20);
  assert.equal(disconnected, true);
});

test('acceptance: QUEUE loop returns to the first track after the last', async () => {
  const { player, queue } = makePlayer({ trackDuration: 3 });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 3 }));
  queue.loopMode = LoopMode.QUEUE;

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });
  await nextTurn();
  assert.equal(queue.current.title, 'Track B');

  triggerTrackEnd({ mixStream: player.mixStream });
  await nextTurn();
  assert.equal(queue.current.title, 'Track A');

  await player.stop();
});

test('acceptance: short tracks do not trigger reconnect retry', async () => {
  let disconnected = false;
  const { player } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true; },
  });

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });

  await waitMs(20);
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

test('acceptance: unexpected Idle rebuilds mixer and restarts the current track', async () => {
  let createCount = 0;
  const { player, audioPlayer, queue } = makePlayer({
    createPcmSourceFn: async () => {
      createCount += 1;
      return PcmSource.fromBuffers([silentFrame, silentFrame, silentFrame]);
    },
  });

  await player.playNext();
  assert.equal(createCount, 1);
  const oldMix = player.mixStream;
  oldMix.destroy();
  audioPlayer.state = { status: AudioPlayerStatus.Idle };
  audioPlayer.events.get(AudioPlayerStatus.Idle)?.();
  await waitMs(40);

  assert.equal(queue.current.title, 'Track A');
  assert.equal(createCount, 2);
  assert.notEqual(player.mixStream, oldMix);
  assert.equal(player.mixStream.isDestroyed(), false);

  await player.stop();
});

test('acceptance: Idle recovery does not play an empty mixer while the source is still preparing', async () => {
  let createCount = 0;
  let releaseSecond;
  const secondSource = new Promise((resolve) => { releaseSecond = resolve; });
  const { player, audioPlayer, queue } = makePlayer({
    createPcmSourceFn: async () => {
      createCount += 1;
      if (createCount === 2) await secondSource;
      return PcmSource.fromBuffers([silentFrame, silentFrame, silentFrame]);
    },
  });

  await player.playNext();
  const oldMix = player.mixStream;
  oldMix.destroy();
  audioPlayer.state = { status: AudioPlayerStatus.Idle };
  audioPlayer.events.get(AudioPlayerStatus.Idle)?.();
  await waitMs(20);

  assert.equal(createCount, 2);
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Idle);
  assert.equal(player.mixStream.currentSource, null);

  releaseSecond();
  await waitMs(20);

  assert.equal(queue.current.title, 'Track A');
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing);
  assert.ok(player.mixStream.currentSource);

  await player.stop();
});

test('acceptance (mixer): slow handoff keeps queue on track 2 after mixer stream destroy', async () => {
  // Mimics @discordjs/voice: leaving Playing destroys playStream. A slow
  // createPcmSource for track 2 used to race with that destroy and either
  // skip track 2 or leave an empty queue while the bot stayed in VC.
  const frame = Buffer.alloc(FRAME_BYTES);
  let createCount = 0;
  let disconnected = false;
  let exhausted = false;

  const { player, audioPlayer, queue } = makePlayer({
    trackDuration: 3,
    onDisconnect: async () => { disconnected = true; },
    handleQueueExhausted: async () => { exhausted = true; return true; },
    createPcmSourceFn: async () => {
      createCount += 1;
      if (createCount === 2) {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return PcmSource.fromBuffers([frame, frame, frame]);
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 3 }));

  await player.playNext();

  // Natural track end + AudioPlayer destroying the mixer stream mid-handoff.
  const oldMix = player.mixStream;
  triggerTrackEnd({ mixStream: oldMix });
  oldMix.destroy();
  audioPlayer.state = { status: AudioPlayerStatus.Idle };
  audioPlayer.events.get(AudioPlayerStatus.Idle)?.();

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Idle, 'must not play empty mixer during slow handoff');

  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(queue.current?.title, 'Track B');
  assert.equal(queue.isEmpty, false);
  assert.equal(disconnected, false);
  assert.equal(exhausted, false);
  assert.equal(createCount, 2);
  assert.equal(player.mixStream.destroyed, false);
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing);

  await player.stop();
});

test('acceptance (mixer): crossfade arms without cached analysis using fallback plan', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let crossfadeStarted = false;
  const { player, queue } = makePlayer({
    trackDuration: 3,
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 180 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 3,
    videoId: 'vid-b',
  }));

  player.mixStream.on('crossfadestart', () => { crossfadeStarted = true; });

  await player.playNext();
  for (let i = 0; i < 135; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(crossfadeStarted, true, 'expected fallback simple-fade/crossfade to start');
  assert.equal(player.mixStream.isCrossfading, true);
  await player.stop();
});

test('acceptance (mixer): crossfade waits until planned startSec', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let startedPlan = null;
  const durationSec = 4;
  const analysis = {
    version: ANALYSIS_VERSION,
    durationSec,
    lastVocalEndSec: 2.5,
    vocalConfidence: 0.85,
    recommendedOverlapSec: 5,
    tailShape: 'abrupt',
    confidence: 0.8,
    bpm: 120,
    bpmConfidence: 0.6,
  };
  const { player, queue } = makePlayer({
    trackDuration: durationSec,
    track: createTrack({
      title: 'Track A',
      webpageUrl: 'https://example.com/a',
      duration: durationSec,
      videoId: 'vid-a',
    }),
    getTrackAnalysisFn: async () => analysis,
    analyzeTrackFileFn: null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 250 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: durationSec,
    videoId: 'vid-b',
  }));

  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  await player.playNext();
  // 20ms frames: 80 reads ≈ 1.6s, still before lastVocalEndSec 2.5.
  for (let i = 0; i < 80; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(startedPlan, null, 'must not start the fade before lastVocalEndSec');
  assert.equal(player.mixStream.isCrossfading, false);

  for (let i = 0; i < 80; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(startedPlan, 'expected crossfade after the vocal-safe boundary');
  assert.ok(startedPlan.startSec >= 2.5);
  await player.stop();
});

test('acceptance (mixer): cached lastVocalEnd starts a vocal-free crossfade', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let startedPlan = null;
  const durationSec = 3;
  const analysis = {
    version: ANALYSIS_VERSION,
    durationSec,
    lastVocalEndSec: 1.2,
    vocalConfidence: 0.85,
    recommendedOverlapSec: 5,
    tailShape: 'abrupt',
    confidence: 0.8,
    bpm: 120,
    bpmConfidence: 0.6,
  };
  const { player, queue } = makePlayer({
    trackDuration: durationSec,
    track: createTrack({
      title: 'Track A',
      webpageUrl: 'https://example.com/a',
      duration: durationSec,
      videoId: 'vid-a',
    }),
    getTrackAnalysisFn: async () => analysis,
    analyzeTrackFileFn: null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 200 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: durationSec,
    videoId: 'vid-b',
  }));

  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  await player.playNext();
  for (let i = 0; i < 160; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.ok(startedPlan, 'expected analysis-driven crossfade to start');
  assert.equal(startedPlan.mode, 'crossfade');
  assert.equal(startedPlan.baseSwap, true);
  assert.ok(startedPlan.startSec >= 1.2);
  await player.stop();
});

test('acceptance (mixer): /fade off skips crossfade and stays gapless', async () => {
  const previousSettingsPath = getSettingsPathForTest();
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-fade-player-test-'));
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'));
  try {
    await setFade('guild-1', false);
    const frame = Buffer.alloc(FRAME_BYTES);
    let crossfadeStarted = false;
    const { player, queue } = makePlayer({
      trackDuration: 3,
      getTrackAnalysisFn: async () => null,
      analyzeTrackFileFn: null,
      createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 180 }, () => frame)),
    });
    queue.add(createTrack({
      title: 'Track B',
      webpageUrl: 'https://example.com/b',
      duration: 3,
      videoId: 'vid-b',
    }));

    player.mixStream.on('crossfadestart', () => { crossfadeStarted = true; });

    await player.playNext();
    for (let i = 0; i < 135; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 450));

    assert.equal(crossfadeStarted, false, 'expected fade-off guilds to skip simple-fade/crossfade');
    assert.equal(player.mixStream.isCrossfading, false);
    await player.stop();
  } finally {
    configureSettingsPathForTest(previousSettingsPath);
    await rm(dir, { recursive: true, force: true });
  }
});

test('acceptance (mixer): disabling fade during arm prevents a late startCrossfade', async () => {
  const previousSettingsPath = getSettingsPathForTest();
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-fade-recheck-test-'));
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'));
  try {
    const frame = Buffer.alloc(FRAME_BYTES);
    let crossfadeStarted = false;
    const { player, queue } = makePlayer({
      trackDuration: 3,
      getTrackAnalysisFn: async () => null,
      analyzeTrackFileFn: null,
      createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 180 }, () => frame)),
    });
    queue.add(createTrack({
      title: 'Track B',
      webpageUrl: 'https://example.com/b',
      duration: 3,
      videoId: 'vid-b',
    }));
    player.mixStream.on('crossfadestart', () => { crossfadeStarted = true; });

    await player.playNext();
    await setFade('guild-1', false);
    for (let i = 0; i < 135; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 450));

    assert.equal(crossfadeStarted, false, 'fade-off after arm start must still skip startCrossfade');
    await player.stop();
  } finally {
    configureSettingsPathForTest(previousSettingsPath);
    await rm(dir, { recursive: true, force: true });
  }
});

test('acceptance (mixer): crossfade timer defers analysis until the transition window', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let analysisRequests = 0;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => {
      analysisRequests += 1;
      return null;
    },
    analyzeTrackFileFn: null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 180 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    videoId: 'vid-b',
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(analysisRequests, 0);
  await player.stop();
});

test('acceptance (mixer): snap handoff when metadata outlasts actual PCM', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let createCount = 0;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    createPcmSourceFn: async () => {
      createCount += 1;
      return PcmSource.fromBuffers([frame, frame]);
    },
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 30));

  for (let i = 0; i < 20; i += 1) {
    player.mixStream.read(FRAME_BYTES);
    await nextTurn();
    if (queue.current.title === 'Track B') break;
  }

  assert.equal(queue.current.title, 'Track B');
  assert.equal(createCount, 2, 'handoff must reuse prepared incoming, not redownload');
  await player.stop();
});

test('acceptance (mixer): trackend handoff reuses prepared incoming', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let createCount = 0;
  const { player, queue } = makePlayer({
    trackDuration: 3,
    createPcmSourceFn: async () => {
      createCount += 1;
      return PcmSource.fromBuffers([frame, frame, frame]);
    },
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 3,
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 30));

  triggerTrackEnd({ mixStream: player.mixStream });
  await nextTurn();

  assert.equal(queue.current.title, 'Track B');
  assert.equal(createCount, 2);
  await player.stop();
});

test('acceptance (mixer): persistent analysis cache skips Demucs lookahead', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let analyzeCalls = 0;
  let prefetchCalls = 0;
  const analysis = {
    version: ANALYSIS_VERSION,
    durationSec: 60,
    lastVocalEndSec: 50,
    vocalConfidence: 0.85,
    recommendedOverlapSec: 3,
    tailShape: 'abrupt',
    confidence: 0.8,
    bpm: 120,
    bpmConfidence: 0.6,
  };
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => analysis,
    analyzeTrackFileFn: async () => {
      analyzeCalls += 1;
      return analysis;
    },
    prefetchTrackFn: async () => {
      prefetchCalls += 1;
      return { filePath: `/tmp/musicbot-prefetch-${prefetchCalls}`, measured: {} };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    videoId: 'vid-b',
  }));
  queue.add(createTrack({
    title: 'Track C',
    webpageUrl: 'https://example.com/c',
    duration: 60,
    videoId: 'vid-c',
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(analyzeCalls, 0, 'cached fresh-version analysis must not launch Demucs');
  assert.equal(prefetchCalls, 1, 'analysis-only lookahead must not download when cache hits');
  await player.stop();
});

test('acceptance (mixer): early queue refill is a single shared attempt', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  let calls = 0;
  const { player } = makePlayer({
    trackDuration: 3,
    handleQueueExhausted: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
      return false;
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 180 }, () => frame)),
  });

  await player.playNext();
  for (let i = 0; i < 10; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(calls, 1, 'arm polls must not start overlapping exhaustion rounds');
  await player.stop();
});

test('acceptance (mixer): lookahead analysis does not persist YouTube metadata duration', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  const seenDurations = [];
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({
      title: 'Track A',
      webpageUrl: 'https://example.com/a',
      duration: 60,
      videoId: 'vid-a',
    }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async (_filePath, opts) => {
      seenDurations.push(opts.durationSec);
      return {
        version: ANALYSIS_VERSION,
        durationSec: 54,
        lastVocalEndSec: 50,
        vocalConfidence: 0.8,
        confidence: 0.7,
      };
    },
    prefetchTrackFn: async (track) => ({
      filePath: `/tmp/musicbot-prefetch-${track.videoId}`,
      measured: {},
    }),
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    videoId: 'vid-b',
  }));
  queue.add(createTrack({
    title: 'Track C',
    webpageUrl: 'https://example.com/c',
    duration: 60,
    videoId: 'vid-c',
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(seenDurations.length > 0, 'lookahead must still run analysis on a cache miss');
  assert.ok(
    seenDurations.every((durationSec) => durationSec == null || durationSec !== 60),
    'analysis must not use untrimmed YouTube metadata duration',
  );
  await player.stop();
});
