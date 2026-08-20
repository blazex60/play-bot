import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { AudioPlayerStatus } from '@discordjs/voice';
import { LoopMode, createTrack, GuildQueue } from './queue.js';
import { isShortTrack, shouldReconnectRetry } from './player/playbackPolicy.js';
import { triggerTrackEnd } from './player/playbackDrive.js';
import { makePlayer, makeAudioPlayer, nextTurn } from './player/test-helpers.js';
import { GuildPlayer } from './player.js';
import { FRAME_BYTES } from './audio/fade.js';
import { PcmSource } from './audio/pcmSource.js';
import { ANALYSIS_VERSION } from './audio/trackAnalysis.js';
import { planBeatSyncedTransition } from './audio/beatmixTransition.js';
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

test('acceptance (mixer): beatmix transition spawns a tempo-matched, seeked incoming source and carries session tempo across promotion', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  let startedPlan = null;
  const incomingSpawnArgs = [];

  // §9.2/§16 tier 1: bpm/beatConfidence/downbeatGrid.confidence/meter on
  // both sides, a vocal-safe phrase-boundary exit (outgoing) and entry
  // (incoming) with >= 2 bars (4s @ 120BPM) of forward-safe room. Same BPM
  // on both sides keeps tempoRatio exactly 1, so the only thing under test
  // is the wiring (spawn options, plan shape, promotion) — not the planner
  // math itself, which beatmixTransition.test.js already covers in depth.
  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    lastVocalEndSec: 1.0,
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const incomingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { head: [{ sec: 0.2, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };

  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async (track, opts) => {
      if (track.videoId === 'vid-b') incomingSpawnArgs.push(opts);
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  await player.playNext();
  // 20ms frames: 60 reads = 1.2s, past the 1.0s exitStartSec.
  for (let i = 0; i < 60; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(startedPlan, 'expected a beatmix transition to arm and start');
  assert.equal(startedPlan.mode, 'beatmix');
  assert.equal(startedPlan.targetBpm, 120);
  assert.ok(startedPlan.startSec >= 1.0 - 1e-6);

  assert.ok(incomingSpawnArgs.length >= 1, 'expected the incoming source to actually be (re-)spawned');
  const spawned = incomingSpawnArgs[incomingSpawnArgs.length - 1];
  assert.ok(
    Math.abs(spawned.startSec - 0.2) < 1e-6,
    `expected the incoming spawn to seek to the plan's entrySec, got ${spawned.startSec}`,
  );
  assert.ok(
    typeof spawned.tempoFilter === 'string' && spawned.tempoFilter.startsWith('rubberband=tempo='),
    `expected a tempo filter on the incoming spawn, got ${spawned.tempoFilter}`,
  );

  // Drive well past the 4s (2-bar) overlap so the crossfade promotes Track B.
  for (let i = 0; i < 220; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }

  assert.equal(queue.current.videoId, 'vid-b', 'expected the beatmix crossfade to promote track B');
  assert.deepEqual(
    player.sessionTempo,
    { nativeBpm: 120, playbackBpm: 120, tempoRatio: 1 },
    'expected the promoted session tempo to carry the beatmix plan\'s incoming tempo state, not reset to a fresh lookup',
  );

  // Codex round-1 P1: the incoming source was spawned seeked to entrySec
  // (0.2s), so Track B's remaining playback is (8 - 0.2) = 7.8s native, not
  // the full 8s — tempoRatio is 1 here so playback-domain is the same.
  // The 220-read loop above consumes the 4s (200-frame) overlap plus 20
  // more frames (0.4s) of Track B as sole "current" afterward, so
  // positionSec sits at ~4.4s post-promotion: remainingSec ~= 7.8 - 4.4 =
  // 3.4s. Before the fix this would read ~3.8s (entrySec never subtracted
  // from the native duration fed to setDurationSec).
  assert.ok(
    Math.abs(player.mixStream.remainingSec - 3.4) < 0.05,
    `expected remainingSec to subtract the 0.2s entry seek from Track B's duration, got ${player.mixStream.remainingSec}`,
  );

  await player.stop();
});

test('acceptance (mixer): an unavailable tempo backend rejects beatmix instead of spawning an unsupported filter', async () => {
  // Same shape as the beatmix acceptance fixture above, but with a BPM gap
  // that actually requires a stretch (122 vs 120, ~1.7% — well within
  // range) and a tempo backend probe that resolves null (genuinely no
  // rubberband/atempo support) rather than being mocked to 'rubberband'.
  // Before the fix, `tempoBackend ?? 'rubberband'` would substitute
  // 'rubberband' here and let planBeatmixTransition emit a filter ffmpeg
  // cannot actually apply.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  let startedPlan = null;

  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    lastVocalEndSec: 1.0,
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const incomingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 122,
    headBpm: 122,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { head: [{ sec: 0.2, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };

  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  await player.playNext();
  for (let i = 0; i < 60; i += 1) {
    player.mixStream.read(FRAME_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(startedPlan, 'expected a transition to still start via the fallback ladder');
  assert.notEqual(startedPlan.mode, 'beatmix', 'a null tempo backend must reject beatmix, not fall back to a bogus rubberband filter');

  await player.stop();
});

test('acceptance (mixer): a chained beatmix transition subtracts the current source\'s own entry offset from the next exit timestamp', async () => {
  // Codex round-3 P1: once A->B promotes B with a nonzero entrySec baked
  // into its spawn (createFileSource's startSec seek), MixStream.positionSec
  // for B is relative to THAT seek point, not native 0 — but B's own
  // analysis.exitStartSec (the timestamp #maybeStartCrossfade compares
  // positionSec against for the B->C transition) remains an ABSOLUTE
  // position in B's native file. Without subtracting B's own entry offset
  // first, the computed threshold sits (B's entrySec) seconds later than
  // positionSec can ever reach relative to its actual start point.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const firedPlans = [];
  const incomingSpawnArgsByTrack = new Map();

  const BS_ENTRY_SEC = 5.0; // B's own entry offset, baked in by A->B.
  const BC_EXIT_SEC = 20.0; // absolute, native position in B's file.
  const FIXED_THRESHOLD = BC_EXIT_SEC - BS_ENTRY_SEC; // 15.0
  const BUGGY_THRESHOLD = BC_EXIT_SEC; // 20.0 (pre-fix, unsubtracted)

  const analysisA = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    lastVocalEndSec: 1.0,
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const analysisB = {
    version: ANALYSIS_VERSION,
    durationSec: 30,
    lastVocalEndSec: BC_EXIT_SEC,
    // Must be strictly after BS_ENTRY_SEC — findEntryCandidates() only
    // offers entry points before firstVocalStartSec (or inside a
    // headVocalGaps window) as vocal-safe.
    firstVocalStartSec: BS_ENTRY_SEC + 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    // head candidate: B's OWN entry offset when promoted from A.
    // tail candidate: the exit point B->C must arm against.
    phrases: {
      head: [{ sec: BS_ENTRY_SEC, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }],
      tail: [{ sec: BC_EXIT_SEC, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }],
    },
    analysisSource: 'demucs',
  };
  const analysisC = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { head: [{ sec: 0.5, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };
  const analysisByVideoId = { 'vid-a': analysisA, 'vid-b': analysisB, 'vid-c': analysisC };

  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => analysisByVideoId[videoId] ?? null,
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async (track, opts) => {
      if (!incomingSpawnArgsByTrack.has(track.videoId)) incomingSpawnArgsByTrack.set(track.videoId, []);
      incomingSpawnArgsByTrack.get(track.videoId).push(opts);
      return PcmSource.fromBuffers(Array.from({ length: 2500 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 30, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 8, videoId: 'vid-c' }));

  player.mixStream.on('crossfadestart', (plan) => { firedPlans.push(plan); });

  await player.playNext();
  for (let i = 0; i < 60; i += 1) player.mixStream.read(FRAME_BYTES);
  await pollUntil(() => firedPlans.length >= 1);
  assert.equal(firedPlans.length, 1, 'expected the A->B beatmix transition to arm');

  for (let i = 0; i < 220; i += 1) player.mixStream.read(FRAME_BYTES);
  assert.equal(queue.current.videoId, 'vid-b', 'expected A->B to promote Track B');
  assert.ok(
    (incomingSpawnArgsByTrack.get('vid-b') ?? []).some((opts) => Math.abs((opts.startSec ?? 0) - BS_ENTRY_SEC) < 1e-6),
    'expected Track B to have been spawned seeked to its own entrySec',
  );

  // positionSec is now relative to B's own (seeked) start. Drive to a
  // checkpoint clearly short of the FIXED threshold first — this must not
  // arm the B->C transition under either the fixed or buggy math.
  const baseline = player.mixStream.positionSec;
  const toCheckpoint1 = Math.max(0, Math.ceil(((FIXED_THRESHOLD - 2) - baseline) / 0.02));
  for (let i = 0; i < toCheckpoint1; i += 1) player.mixStream.read(FRAME_BYTES);
  await waitMs(300);
  assert.equal(firedPlans.length, 1, 'expected no B->C transition yet, well short of the fixed threshold');

  // Drive past the FIXED threshold (exitStartSec - B's own entrySec) while
  // staying clear of the BUGGY (unsubtracted) one — only entry-offset-
  // subtracted math can have armed by here.
  const afterCheckpoint1 = player.mixStream.positionSec;
  const toCheckpoint2 = Math.max(0, Math.ceil(((FIXED_THRESHOLD + 2) - afterCheckpoint1) / 0.02));
  for (let i = 0; i < toCheckpoint2; i += 1) player.mixStream.read(FRAME_BYTES);
  await pollUntil(() => firedPlans.length >= 2);

  assert.ok(
    player.mixStream.positionSec < BUGGY_THRESHOLD,
    `test invariant broken: positionSec (${player.mixStream.positionSec}) reached the buggy threshold — widen the margin`,
  );
  assert.equal(
    firedPlans.length,
    2,
    'expected the B->C transition to arm once positionSec passed (exitStartSec - B\'s own entrySec), not the unsubtracted exitStartSec',
  );
  assert.ok(
    (incomingSpawnArgsByTrack.get('vid-c') ?? []).length >= 1,
    'expected Track C\'s incoming source to actually be spawned',
  );

  await player.stop();
});

test('acceptance (mixer): incoming prep for a beatmix plan starts relative to the selected exit point, not just time-to-EOF', async () => {
  // Codex round-3 P2: the prep gate must fire based on distance to the
  // SELECTED exit point (startSec), not distance to EOF. Track A's exit
  // candidate sits far before EOF (12s into a 40s track) — under the old
  // EOF-relative gate (remaining <= fadeSec + CROSSFADE_PREP_LEAD_SEC),
  // prep wouldn't fire until `remaining` shrinks near 19s (position ~21s+),
  // long after the 12s exit point was already reached. The fixed gate opens
  // as soon as positionSec is within CROSSFADE_PREP_LEAD_SEC of startSec.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const incomingSpawnArgs = [];

  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 40,
    lastVocalEndSec: 12.0,
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { tail: [{ sec: 12.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const incomingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { head: [{ sec: 0.2, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };

  const { player, queue } = makePlayer({
    trackDuration: 40,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 40, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async (track, opts) => {
      if (track.videoId === 'vid-b') incomingSpawnArgs.push(opts);
      return PcmSource.fromBuffers(Array.from({ length: 2500 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  await player.playNext();
  // No frames read at all — positionSec is still 0. Give the arm timer a
  // single 200ms tick.
  await waitMs(300);

  assert.ok(
    incomingSpawnArgs.some((opts) => Math.abs((opts.startSec ?? 0) - 0.2) < 1e-6),
    'expected the beatmix-specific incoming prep (seeked to entrySec) to have already been requested, ' +
    'even though remaining time-to-EOF (40s) is nowhere close to fadeSec + CROSSFADE_PREP_LEAD_SEC',
  );

  await player.stop();
});

test('acceptance (mixer): a phrase-crossfade with an unhonored entry seek downgrades baseSwap, not just beatmix mode', async () => {
  // Codex round-4: the downgrade-when-unhonored guard only checked
  // `norm.mixPlan.mode === 'beatmix'` — but normalizeTransitionPlan() already
  // flattens phrase-crossfade into mixPlan.mode: 'crossfade', so an unhonored
  // phrase-crossfade (source fell back to createStreamSource, native
  // position 0) sailed through unchanged, still carrying baseSwap: true from
  // a plan that assumed the incoming audio started at its selected
  // vocal-safe phrase boundary. No BPM data on either side forces
  // planBeatSyncedTransition to reject beatmix (bpm-unavailable) and fall
  // through to phrase-crossfade, which doesn't require BPM at all.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  let startedPlan = null;

  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    lastVocalEndSec: 1.0,
    vocalConfidence: 0.85,
    confidence: 0.8,
    phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const incomingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    phrases: { head: [{ sec: 0.2, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };

  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async (track, opts) => {
      const source = PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
      // Simulate a normalize-ineligible/failed Track B: createStreamSource's
      // real fallback ignores startSec/tempoFilter and marks the source
      // accordingly.
      if (track.videoId === 'vid-b') source.tempoHonored = false;
      return source;
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  await player.playNext();
  for (let i = 0; i < 60; i += 1) player.mixStream.read(FRAME_BYTES);
  await waitMs(300);

  assert.ok(startedPlan, 'expected a phrase-crossfade transition to arm');
  assert.equal(startedPlan.mode, 'crossfade');
  assert.equal(
    startedPlan.baseSwap,
    false,
    'expected baseSwap to be stripped once the incoming source could not honor the plan\'s selected entry point',
  );

  await player.stop();
});

test('acceptance (mixer): an unhonored beatmix with a zero entry offset still downgrades (tempo-only mismatch)', async () => {
  // Codex round-5: round-4's guard broadened from mode==='beatmix' to
  // norm.entrySec > 0, but a beatmix's selected entry candidate can land
  // at entrySec === 0 while still requiring a nonzero tempo filter (a BPM
  // mismatch within stretch range). entrySec alone missed that case,
  // leaving mode: 'beatmix' (bar-envelope EQ) running against audio that
  // fell back to native, unstretched tempo instead of the planned stretch.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  let startedPlan = null;

  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    lastVocalEndSec: 1.0,
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const incomingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    // Zero-sec head candidate: entrySec will be 0, but headBpm still
    // differs from the outgoing target enough to require a tempo filter.
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 122,
    headBpm: 122,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { head: [{ sec: 0, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };

  // Pin the fixture: it must actually produce a zero-sec entry candidate
  // paired with a nonzero tempo filter, or this stops exercising the
  // regression this test targets.
  const rawPlan = planBeatSyncedTransition(outgoingAnalysis, incomingAnalysis, {
    outgoingPlaybackBpm: 120,
    tempoBackend: 'rubberband',
    maxOverlapSec: 6,
  });
  assert.equal(rawPlan.mode, 'beatmix', 'test invariant: expected the planner to pick beatmix for this fixture');
  assert.equal(rawPlan.incoming?.entrySec, 0, 'test invariant: expected a zero-sec entry candidate');
  assert.ok(
    typeof rawPlan.incoming?.tempoFilter === 'string' && rawPlan.incoming.tempoFilter.length > 0,
    'test invariant: expected the fixture\'s BPM mismatch to require a tempo filter',
  );

  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async (track, opts) => {
      const source = PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
      if (track.videoId === 'vid-b') source.tempoHonored = false;
      return source;
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  await player.playNext();
  for (let i = 0; i < 60; i += 1) player.mixStream.read(FRAME_BYTES);
  await waitMs(300);

  assert.ok(startedPlan, 'expected a transition to arm');
  assert.equal(
    startedPlan.mode,
    'crossfade',
    'expected the zero-entry beatmix to still downgrade out of bar-envelope mode once its tempo filter went unhonored',
  );

  await player.stop();
});

test('acceptance (mixer): fresh session tempo baselines from head BPM, not the tail-biased aggregate', async () => {
  // Codex round-5 P1: #resetSessionTempoFor seeded sessionTempo.playbackBpm
  // from analysis.bpm (tail-biased per trackAnalysis.js). outgoingActualTargetBpm()
  // then scales the tail BPM by (playbackBpm / analysis.headBpm) — for a
  // ratio-1 (unstretched) session that formula is only an identity when
  // playbackBpm equals headBpm. Seeding from the tail-biased value instead
  // reports a distorted "actual tail tempo" for any track whose head/tail
  // BPM differ, corrupting the beatmix planner's tempo match.
  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 30,
    headBpm: 120,
    bpm: 125,
    beatConfidence: 0.7,
    confidence: 0.8,
  };

  const { player, queue } = makePlayer({
    trackDuration: 30,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 30, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : null),
    analyzeTrackFileFn: null,
  });
  // A second queued track gives the crossfade-arm loop a `next` to plan
  // against, which is what actually fetches (and backfills nativeBpm from)
  // the current track's analysis — #resetSessionTempoFor's own fast-path
  // read misses on a fresh track (analysis isn't fetched until afterward),
  // and with no `next` at all the arm loop returns before ever calling
  // #getCachedAnalysis(current) since `track.duration` already satisfies
  // mixStream.remainingSec on its own.
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 30, videoId: 'vid-b' }));

  await player.playNext();
  await pollUntil(() => player.sessionTempo.playbackBpm != null);

  assert.equal(
    player.sessionTempo.playbackBpm,
    120,
    'expected a fresh session\'s playbackBpm to baseline from headBpm (120), not the tail-biased aggregate bpm (125)',
  );

  await player.stop();
});

test('acceptance (mixer): TRACK loop mode restarts from the beginning, not the beatmix entry candidate', async () => {
  // Codex round-5: LoopMode.TRACK re-arms with next === current, but
  // planBeatSyncedTransition still picks a head-window entry candidate for
  // `next` as if it were a different, upcoming song. Without forcing the
  // entry back to 0, a high-scoring head-phrase candidate deep into the
  // file would seek there on every repeat — after the very first loop, the
  // track permanently loses its intro instead of replaying the whole song.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const incomingSpawnArgs = [];

  // Same track's analysis serves as both outgoing (tail exit) and incoming
  // (head entry) — a real head-phrase candidate sits well into the file.
  const analysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    lastVocalEndSec: 1.0,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: {
      tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }],
      head: [{ sec: 3.0, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }],
    },
    analysisSource: 'demucs',
  };

  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => analysis,
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async (track, opts) => {
      incomingSpawnArgs.push(opts);
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.loopMode = LoopMode.TRACK;

  // Confirm the fixture actually exercises the bug: absent the TRACK-loop
  // guard, this same analysis pair (used as both outgoing and incoming)
  // really does make the planner pick the nonzero head candidate as entrySec.
  const rawPlan = planBeatSyncedTransition(analysis, analysis, {
    outgoingPlaybackBpm: 120,
    tempoBackend: 'rubberband',
    maxOverlapSec: 6,
  });
  const wouldBeEntrySec = rawPlan.mode === 'beatmix' ? rawPlan.incoming?.entrySec : rawPlan.entrySec;
  assert.ok(
    wouldBeEntrySec > 0,
    `test invariant: expected the planner to pick a nonzero entry candidate for this fixture, got ${wouldBeEntrySec}`,
  );

  await player.playNext();
  for (let i = 0; i < 60; i += 1) player.mixStream.read(FRAME_BYTES);
  await waitMs(300);

  assert.ok(
    incomingSpawnArgs.length >= 2,
    `expected the TRACK loop to actually spawn the same track again, got ${incomingSpawnArgs.length} spawn(s)`,
  );
  const nonzeroSpawns = incomingSpawnArgs.filter((opts) => (opts.startSec ?? 0) !== 0);
  assert.equal(
    nonzeroSpawns.length,
    0,
    `expected every TRACK-loop repeat spawn to start at 0 (full replay), got nonzero startSec in: ${JSON.stringify(nonzeroSpawns)}`,
  );

  await player.stop();
});

function spawnBuffered(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
      else resolve({ stderr });
    });
  });
}

async function pollUntil(predicate, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await waitMs(intervalMs);
  }
  return predicate();
}

test('acceptance (mixer): re-prepping the same incoming track for a beatmix plan reuses the already-downloaded file', async (t) => {
  // Codex round-2: #ensureIncomingPrep's mismatch-triggered re-prep must not
  // delete and re-fetch a file the eager default prep already downloaded —
  // exercises the REAL #createPcmSource normalize pipeline (no
  // createPcmSourceFn override), so prefetchTrackFn/createFileSource really
  // run against an on-disk file. Skips when ffmpeg itself is unavailable,
  // unlike the rest of this suite which mocks the PCM source and has no
  // ffmpeg dependency.
  const hasFfmpeg = await spawnBuffered('ffmpeg', ['-hide_banner', '-version']).then(() => true, () => false);
  if (!hasFfmpeg) {
    t.skip('ffmpeg is not available in this environment');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-reuse-test-'));
  const filePath = join(dir, 'track-b.wav');
  try {
    await spawnBuffered('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
      filePath,
    ]);

    let prefetchCalls = 0;
    let startedPlan = null;
    const outgoingAnalysis = {
      version: ANALYSIS_VERSION,
      durationSec: 8,
      lastVocalEndSec: 1.0,
      vocalConfidence: 0.85,
      confidence: 0.8,
      bpm: 120,
      beatConfidence: 0.7,
      downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
      phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
      analysisSource: 'demucs',
    };
    const incomingAnalysis = {
      version: ANALYSIS_VERSION,
      durationSec: 8,
      firstVocalStartSec: 5.0,
      headVocalGaps: [],
      vocalConfidence: 0.85,
      confidence: 0.8,
      bpm: 120,
      headBpm: 120,
      beatConfidence: 0.7,
      downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
      phrases: { head: [{ sec: 0.2, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
      analysisSource: 'demucs',
    };

    // Constructed directly (not via makePlayer()) because makePlayer always
    // supplies a default createPcmSourceFn mock when none is given, which
    // short-circuits #createPcmSource before it ever reaches the real
    // normalize/prefetch pipeline this test needs to exercise.
    const audioPlayer = makeAudioPlayer();
    const queue = new GuildQueue();
    queue.add(createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }));
    const player = new GuildPlayer({
      guildId: 'guild-1',
      queue,
      audioPlayer,
      getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
      analyzeTrackFileFn: null,
      probeTempoBackendFn: async () => 'rubberband',
      prefetchTrackFn: async (track) => {
        if (track.videoId === 'vid-b') prefetchCalls += 1;
        return {
          filePath,
          measured: { measured_I: -16, measured_TP: -1.5, measured_LRA: 11, measured_thresh: -30, offset: 0 },
        };
      },
      connection: { subscribe() {} },
      onDisconnect: async () => {},
      resolveAudioStreamFn(url) { return { url }; },
      createAudioResourceFn(stream, options) { return { stream, options, playStream: { destroy() {} } }; },
    });
    queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

    player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

    await player.playNext();
    // Let the eager default prep (#ensureIncomingPrepForUpcoming, startSec=0)
    // for Track B finish downloading/normalizing first. Real ffmpeg spawn +
    // decode, unlike the mocked PcmSource used elsewhere, needs actual
    // wall-clock time — poll with a generous deadline instead of a fixed
    // sleep so a slow/loaded machine doesn't fail for an unrelated reason.
    await pollUntil(() => prefetchCalls >= 1, { timeoutMs: 5000 });
    assert.equal(prefetchCalls, 1, 'expected the eager default prep to fetch Track B once');

    // remaining (8s) is already inside the beatmix plan's prepWindow from the
    // very first arm tick (positionSec 0 is within CROSSFADE_PREP_LEAD_SEC of
    // startSec ~1.0s), so the re-prep decision — reuse vs re-fetch — happens
    // on the first tick after playNext, well before positionSec would ever
    // reach the plan's exitStartSec. No need to drive frames through a full
    // crossfade to observe it; just give the 200ms arm timer a few ticks to
    // land the mismatch-triggered re-prep, then confirm no SECOND fetch
    // followed it (an absence check, so this still needs a bounded wait
    // rather than a poll-until-true condition).
    await waitMs(800);

    assert.equal(
      prefetchCalls,
      1,
      'expected the beatmix re-prep to reuse the already-downloaded file, not re-fetch it',
    );

    await player.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  // Phase 7D round-2: the arm loop's early-return gate now covers
  // CROSSFADE_PREP_LEAD_SEC + MAX_TRANSITION_LEAD_SEC (TAIL_WINDOW_SEC =
  // 45s), so remaining must exceed 60s for the gate to still be closed at
  // the start — a 60s track sits exactly ON that boundary.
  const frame = Buffer.alloc(FRAME_BYTES);
  let analysisRequests = 0;
  const { player, queue } = makePlayer({
    trackDuration: 90,
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
    duration: 90,
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

test('acceptance (mixer): stem separation input is staged before the analysis queue can lose it (Codex)', async () => {
  // Codex (PR #39, round 14): #scheduleAnalysis()'s stem-separation call
  // used the SAME filePath several unrelated cleanup call sites (track
  // promotion/stop/skip/prefetch discard) can delete at any time — including
  // the entire span this job sits queued behind another guild's full-track
  // Demucs run (docs/mix-transition-phase8.md §9's already-documented
  // analysisQueue contention). By the time this job's turn came up, filePath
  // could already be gone. The fix stages an independent copy immediately,
  // synchronously off the same call that hands filePath to #scheduleAnalysis
  // — before enqueue, not after — so separation always reads from a copy
  // nothing else can touch, never from the (possibly already-deleted)
  // original.
  const frame = Buffer.alloc(FRAME_BYTES);
  const originalFilePath = '/tmp/musicbot-original-vid-b';
  const stagedFilePath = '/tmp/musicbot-staged-vid-b';
  const stageCalls = [];
  const separateCalls = [];
  const analysis = {
    version: ANALYSIS_VERSION,
    durationSec: 60,
    lastVocalEndSec: 50,
    vocalConfidence: 0.85,
    confidence: 0.8,
  };
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => analysis,
    prefetchTrackFn: async () => ({ filePath: originalFilePath, measured: {} }),
    stageTempFileCopyFn: async (filePath) => {
      stageCalls.push(filePath);
      return stagedFilePath;
    },
    separateTrackStemsFn: async (filePath, videoId) => {
      separateCalls.push({ filePath, videoId });
      return null;
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    videoId: 'vid-b',
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(stageCalls, [originalFilePath],
    'expected the original prefetched file to be staged, exactly once');
  assert.equal(separateCalls.length, 1, 'expected exactly one separation attempt');
  assert.equal(separateCalls[0].filePath, stagedFilePath,
    'expected separation to receive the staged copy, not the original filePath');
  assert.equal(separateCalls[0].videoId, 'vid-b');
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

// --- Phase 8 (docs/mix-transition-phase8.md): stem-mix transitions -------

function stemFixtures() {
  const outgoingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    // Still singing well past the only exit candidate below (1.0s) — plain
    // beatmix's findExitCandidates() rejects this outright; stem-mix is the
    // only tier that can still accept the pair.
    lastVocalEndSec: 5.5,
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { tail: [{ sec: 1.0, barIndex: 0, score: 0.6, reasons: ['bar-multiple'] }], head: [] },
    analysisSource: 'demucs',
  };
  const incomingAnalysis = {
    version: ANALYSIS_VERSION,
    durationSec: 8,
    firstVocalStartSec: 5.0,
    headVocalGaps: [],
    vocalConfidence: 0.85,
    confidence: 0.8,
    bpm: 120,
    headBpm: 120,
    beatConfidence: 0.7,
    downbeatGrid: { source: 'heuristic', meter: 4, confidence: 0.7, head: { downbeatsSec: [] }, tail: { downbeatsSec: [] } },
    phrases: { head: [{ sec: 0.2, barIndex: 0, score: 0.5, reasons: ['bar-multiple'] }], tail: [] },
    analysisSource: 'demucs',
  };
  return { outgoingAnalysis, incomingAnalysis };
}

test('acceptance (mixer): stem-mix transition is chosen when both sides have cached stems and the exit is mid-vocal', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  const stemSourceCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    getCachedStemsFn: async (videoId) => ({
      vocalPath: `/tmp/${videoId}.vocal.wav`,
      instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
    }),
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    for (let i = 0; i < 60; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(startedPlan, 'expected a crossfade to have armed');
    assert.equal(startedPlan.mode, 'stem-mix');
    assert.ok(startedPlan.stems);
    assert.equal(stemSourceCalls.length, 4, 'expected 2 outgoing + 2 incoming stem sources to be spawned');
    assert.ok(stemSourceCalls.some((c) => c.filePath === '/tmp/vid-a.vocal.wav'));
    assert.ok(stemSourceCalls.some((c) => c.filePath === '/tmp/vid-a.instrumental.wav'));
    assert.ok(stemSourceCalls.some((c) => c.filePath === '/tmp/vid-b.vocal.wav'));
    assert.ok(stemSourceCalls.some((c) => c.filePath === '/tmp/vid-b.instrumental.wav'));
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): stem-mix is skipped (falls back to the existing ladder) when stems are not cached', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  const stemSourceCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    getCachedStemsFn: async () => null, // never separated (or not yet finished)
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    for (let i = 0; i < 200; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Whatever the rest of the (untouched) fallback ladder ultimately picks
    // — this fixture's own timing isn't the point here — stem-mix itself
    // must never be attempted when getCachedStemsFn() reports a miss.
    if (startedPlan) assert.notEqual(startedPlan.mode, 'stem-mix');
    assert.equal(stemSourceCalls.length, 0, 'expected zero stem sources spawned when nothing is cached');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a memoized stem-cache hit that is evicted before prep is revalidated, not spawned stale', async () => {
  // Codex: player.js's #stemCacheHit memoizes a positive (current.videoId,
  // next.videoId) cache lookup across many arm-ticks (avoiding a
  // getCachedStemsFn() call — and its mtime touch — on every ~200ms tick
  // while a stem-mix candidate is still just being watched, not yet due for
  // prep). If pruneStemCache() evicts that entry in the background between
  // the memo being set and #ensureOutgoingStemPrep()/#ensureIncomingStemPrep()
  // actually spawning from it, spawning against the stale (now-deleted)
  // paths would silently and permanently fail prep for as long as this pair
  // remains current/next. getCachedStemsFn here reports a hit for the first
  // 2 calls (enough to populate the memo through the initial eligibility
  // check) and a miss on every call after — simulating exactly that
  // eviction window.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  let getCachedStemsCalls = 0;
  const stemSourceCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    getCachedStemsFn: async (videoId) => {
      getCachedStemsCalls += 1;
      if (getCachedStemsCalls > 2) return null;
      return {
        vocalPath: `/tmp/${videoId}.vocal.wav`,
        instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
      };
    },
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    for (let i = 0; i < 200; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(getCachedStemsCalls > 2, 'expected the eligibility check to have populated the memo before eviction');
    // The stale memo must never be trusted to actually spawn ffmpeg
    // sources — revalidation at prep time must have caught the eviction.
    assert.equal(stemSourceCalls.length, 0, 'expected zero stem sources spawned from a since-evicted cache entry');
    if (startedPlan) assert.notEqual(startedPlan.mode, 'stem-mix');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): concurrent arm ticks do not spawn duplicate stem sources while a prep revalidation is in flight', async () => {
  // Codex: #ensureOutgoingStemPrep()/#ensureIncomingStemPrep()'s cache
  // revalidation (added for the memo-eviction fix above) is async, and the
  // 200ms arm interval can call either method again before the FIRST call's
  // await resolves — the identity-based no-op check at the top has nothing
  // to compare against yet, since nothing has been installed. Without a
  // dedup guard, every such tick spawns its own independent ffmpeg pair;
  // slowing getCachedStemsFn down here (well past several arm intervals)
  // reliably reproduces the race and would multiply stemSourceCalls past 4
  // without the #preparing*StemsKey guard.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  const stemSourceCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    getCachedStemsFn: async (videoId) => {
      await new Promise((resolve) => setTimeout(resolve, 300)); // outlasts a couple 200ms arm ticks
      return {
        vocalPath: `/tmp/${videoId}.vocal.wav`,
        instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
      };
    },
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    // Stay well under the fixture's 1.0s exit candidate (readyToFade must
    // stay false) while still comfortably past prepDue's threshold
    // (CROSSFADE_PREP_LEAD_SEC=15s dwarfs this whole 8s track, so prepDue
    // is true almost from position 0) — this opens a window where prep is
    // actively being (re)attempted every arm tick but the take can't fire
    // yet, which is exactly the window the race lives in.
    for (let i = 0; i < 10; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    // Several 200ms arm ticks fire here while getCachedStemsFn's 300ms
    // delay is in flight — this is what used to spawn duplicate stem
    // sources without the #preparing*StemsKey dedup guard.
    await new Promise((resolve) => setTimeout(resolve, 900));

    // Now cross the 1.0s exit point so readyToFade/take can proceed.
    for (let i = 0; i < 60; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.ok(startedPlan, 'expected a crossfade to have armed despite the slow cache revalidation');
    assert.equal(startedPlan.mode, 'stem-mix');
    assert.equal(stemSourceCalls.length, 4,
      `expected exactly 2 outgoing + 2 incoming stem sources despite concurrent arm ticks, got ${stemSourceCalls.length}`);
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a rejected prep revalidation does not permanently disable stem-mix for that pair', async () => {
  // CodeRabbit: #preparing*StemsKey is set before the cache-revalidation
  // await, but was only ever cleared on the SUCCESS paths below it — a
  // rejected getCachedStemsFn() (a transient fs/cache read error) skipped
  // straight past those resets. Every later arm tick for the same identity
  // then hit the dedup no-op (`#preparing*StemsKey === key`) forever, since
  // nothing had cleared it, permanently disabling stem prep for the rest of
  // the transition even though a later read would have succeeded. The fix
  // wraps the revalidation in try/finally so the key is always released.
  //
  // getCachedStemsFn succeeds for the first 2 calls (the eligibility
  // check's Promise.all, memoized afterward by #stemCacheHit), rejects for
  // the next few (simulating a transient failure hit by the ensure-side
  // revalidation), then succeeds — the 200ms arm interval's natural retries
  // should recover once the key is properly released each time.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  let getCachedStemsCalls = 0;
  const stemSourceCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 8,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 8, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    getCachedStemsFn: async (videoId) => {
      getCachedStemsCalls += 1;
      if (getCachedStemsCalls > 2 && getCachedStemsCalls <= 6) {
        throw new Error('transient cache read failure');
      }
      return {
        vocalPath: `/tmp/${videoId}.vocal.wav`,
        instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
      };
    },
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    // Stay under the fixture's 1.0s exit candidate while several arm ticks
    // (200ms each) retry the rejected revalidation and eventually succeed.
    for (let i = 0; i < 10; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Now cross the exit point so readyToFade/take can proceed.
    for (let i = 0; i < 60; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.ok(getCachedStemsCalls > 6, 'expected retries past the rejected calls');
    assert.ok(startedPlan, 'expected a crossfade to have armed once revalidation recovered');
    assert.equal(startedPlan.mode, 'stem-mix');
    assert.equal(stemSourceCalls.length, 4,
      `expected exactly 2 outgoing + 2 incoming stem sources once revalidation recovered, got ${stemSourceCalls.length}`);
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): missing prepared stems at take time aborts instead of downgrading to a plain crossfade', async () => {
  // Codex: stem-mix's exitStartSec/entrySec are chosen with vocal-safety
  // relaxed (requireExitVocalSafe/requireEntryForwardSafe: false) — reusing
  // that same window for a plain (non-separated) crossfade when one side's
  // stem prep never lands would reintroduce the vocal-collision risk 禁止5
  // guards against, since a plain crossfade has no per-stem envelope to
  // keep the outgoing vocal tail clear of the incoming track's own start.
  // #takePreparedOutgoingStems() returning null at take time (outgoing stem
  // spawning keeps failing here) must abort this attempt entirely — never
  // fall through to mixStream.startCrossfade() at the same window.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  const stemSourceCalls = [];
  let incomingSourceTakes = 0;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => {
      incomingSourceTakes += 1;
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
    getCachedStemsFn: async (videoId) => ({
      vocalPath: `/tmp/${videoId}.vocal.wav`,
      instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
    }),
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      if (filePath.includes('vid-a')) {
        // Outgoing stem prep keeps failing to spawn — incoming succeeds.
        throw new Error('simulated outgoing stem spawn failure');
      }
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 8, videoId: 'vid-b' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    for (let i = 0; i < 200; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));

    assert.equal(startedPlan, null,
      'expected the transition to abort rather than downgrade to an unsafe plain crossfade');
    assert.ok(stemSourceCalls.some((c) => c.filePath.includes('vid-a')),
      'expected outgoing stem prep to have been attempted');
    const takesAfterFirstAbort = incomingSourceTakes;
    assert.ok(takesAfterFirstAbort >= 1, 'expected the incoming full-mix source to have been taken at least once');

    // Codex (round-9 follow-up): the cache lookup and stem-plan selection
    // above are independent of spawn success, so without marking this pair
    // unavailable, readyToFade stays true for the rest of the outgoing
    // track — every subsequent ~200ms arm tick would re-select the same
    // relaxed stem plan, re-take a fresh incoming full-mix source (deleting
    // and re-fetching its temp file), and abort again, retrying forever
    // instead of ever letting rawPlan's own fallback run. Wait through
    // several more arm ticks and confirm the retry-take loop has actually
    // stopped, not just that the FIRST abort didn't downgrade unsafely.
    for (let i = 0; i < 400; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(incomingSourceTakes, takesAfterFirstAbort,
      'expected the incoming-source retry-take loop to stop once the pair is marked unavailable, not retry forever');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a stem-mix pair marked unavailable gets a fresh attempt when it recurs (QUEUE loop)', async () => {
  // Codex: #stemMixUnavailableKey is scoped by (current, next).videoId
  // alone — QUEUE loop mode (or a duplicated playlist entry) can bring the
  // SAME pair back around later, and without an explicit reset, a
  // since-resolved (or merely transient) earlier failure would downgrade
  // every future occurrence of that pair for the rest of the GuildPlayer's
  // lifetime. #onCrossfadePromoted()/#handleAfter() now clear the marker
  // once the failed pair's own transition attempt concludes — verify a
  // SECOND lap through the same A→B pair (after two triggerTrackEnd()
  // advances: A→B, then B→A) attempts stem-mix again instead of staying
  // silently downgraded.
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  const stemSourceCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => (videoId === 'vid-a' ? outgoingAnalysis : incomingAnalysis),
    analyzeTrackFileFn: null,
    probeTempoBackendFn: async () => 'rubberband',
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    getCachedStemsFn: async (videoId) => ({
      vocalPath: `/tmp/${videoId}.vocal.wav`,
      instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
    }),
    createFileSourceFn: (filePath, opts) => {
      stemSourceCalls.push({ filePath, opts });
      if (filePath.includes('vid-a')) {
        // Outgoing stem prep for A keeps failing to spawn — every A→B
        // attempt aborts, whichever lap it happens on.
        throw new Error('simulated outgoing stem spawn failure');
      }
      return PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame)));
    },
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.loopMode = LoopMode.QUEUE;

  try {
    await player.playNext();
    for (let i = 0; i < 200; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));

    const vidACallsAfterFirstLap = stemSourceCalls.filter((c) => c.filePath.includes('vid-a')).length;
    assert.ok(vidACallsAfterFirstLap >= 1, 'expected the first A→B stem-mix attempt to have been made');

    // Two natural (non-crossfade) advances: A ends → B (QUEUE loop), then
    // B ends → back to A — bringing the exact same A→B pair around again.
    // shouldReconnectRetry() replays the SAME track instead of advancing
    // when a track "ends" less than RECONNECT_GRACE_MS (5s) after it
    // started (a real premature-disconnect heuristic, unrelated to this
    // test) — wait past that grace period before each triggerTrackEnd()
    // so it reads as a genuine natural completion.
    await new Promise((resolve) => setTimeout(resolve, 4200));
    triggerTrackEnd({ mixStream: player.mixStream });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(queue.current.videoId, 'vid-b', 'expected the queue to have advanced to B');
    await new Promise((resolve) => setTimeout(resolve, 5200));
    triggerTrackEnd({ mixStream: player.mixStream });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(queue.current.videoId, 'vid-a', 'expected the QUEUE loop to have wrapped back to A');

    for (let i = 0; i < 200; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 900));

    const vidACallsAfterSecondLap = stemSourceCalls.filter((c) => c.filePath.includes('vid-a')).length;
    assert.ok(vidACallsAfterSecondLap > vidACallsAfterFirstLap,
      'expected the recurring A→B pair to get a fresh stem-mix attempt on the second lap, not stay downgraded');
  } finally {
    await player.stop();
  }
});
