import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
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

  const logCalls = [];
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
    logTransitionPlanFn: (report) => logCalls.push(report),
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
  // Codex review (PR #43): the [MIX PLAN] report's entry must reflect the
  // entry actually applied (0, since the source fell back to native
  // position 0), not the originally planned nonzero phrase-boundary entry.
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].entry.sec, 0);
  // Codex review round 2: native offset 0 isn't necessarily bar 0 (the
  // downgraded transition no longer uses the original bar candidate at
  // all) — bar is reported as unknown, not asserted.
  assert.equal(logCalls[0].entry.bar, null);

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
    // Phase 9B (docs/mix-transition-phase9.md §4): a cached BPM/phrase
    // analysis does NOT imply cached stems — #ensureStemPrefetch() checks
    // getCachedStemsFn() independently of #ensureAnalysisPrefetch()'s own
    // persisted-analysis short-circuit, since a track can have analysis
    // from a previous play while still missing its Demucs separation.
    // Reporting a stem-cache HIT here keeps this test's original,
    // unrelated assertion (the BPM-analysis-only lookahead must not
    // redownload when analysis is cached) isolated from that new lookup.
    getCachedStemsFn: async () => ({ vocalPath: '/tmp/vocal.wav', instrumentalPath: '/tmp/instrumental.wav' }),
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

test('acceptance (mixer): staged copy is cleaned up even when analysis fails before separation (CodeRabbit)', async () => {
  // CodeRabbit (PR #39, round 15): the round-14 fix's try/finally only
  // wrapped the separation call, not the earlier #lookupPersistentAnalysis()/
  // #runAnalysis() steps. A rejection there (including an ANALYSIS_KILLED
  // abort) exited the queued callback before it ever awaited the staged
  // path or reached the finally block, permanently leaking the
  // already-created staged copy on disk. The finally must wrap the WHOLE
  // callback so every exit path — success, an analysis failure, or a
  // cancellation — still cleans it up.
  const frame = Buffer.alloc(FRAME_BYTES);
  const stagedPath = `/tmp/musicbot-test-staged-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(stagedPath, 'staged content');
  let staged = false;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => {
      throw new Error('simulated analysis failure');
    },
    prefetchTrackFn: async () => ({ filePath: '/tmp/musicbot-original-vid-fail', measured: {} }),
    stageTempFileCopyFn: async () => {
      staged = true;
      return stagedPath;
    },
    separateTrackStemsFn: async () => {
      throw new Error('must not be called — analysis already failed');
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track Fail',
    webpageUrl: 'https://example.com/fail',
    duration: 60,
    videoId: 'vid-fail',
  }));

  try {
    await player.playNext();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(staged, true, 'expected staging to have been attempted');
    await assert.rejects(() => access(stagedPath),
      'expected the staged copy to be cleaned up even though analysis failed before separation');
  } finally {
    await rm(stagedPath, { force: true });
    await player.stop();
  }
});

test('acceptance (mixer): analysis reads from the staged copy too, not just separation (Codex)', async () => {
  // Codex (PR #39, round 17): the whole reason filePath gets staged is
  // that unrelated cleanup can delete it at any point once this job is
  // enqueued — #runAnalysis() is just as exposed to that as separation
  // was, but round-14/15's fix only routed the STAGED path into
  // separateTrackStemsFn(), leaving #runAnalysis() reading the original,
  // possibly-already-deleted filePath.
  const frame = Buffer.alloc(FRAME_BYTES);
  const originalFilePath = '/tmp/musicbot-original-vid-analysis';
  const stagedFilePath = '/tmp/musicbot-staged-vid-analysis';
  const analyzeCalls = [];
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
    analyzeTrackFileFn: async (fp) => {
      analyzeCalls.push(fp);
      return analysis;
    },
    prefetchTrackFn: async () => ({ filePath: originalFilePath, measured: {} }),
    stageTempFileCopyFn: async () => stagedFilePath,
    separateTrackStemsFn: async (fp, videoId) => {
      separateCalls.push({ fp, videoId });
      return null;
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => frame)),
  });
  queue.add(createTrack({
    title: 'Track Analysis',
    webpageUrl: 'https://example.com/analysis',
    duration: 60,
    videoId: 'vid-analysis',
  }));

  await player.playNext();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(analyzeCalls, [stagedFilePath],
    'expected analysis to read from the staged copy, not the original filePath');
  assert.equal(separateCalls.length, 1);
  assert.equal(separateCalls[0].fp, stagedFilePath);
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

// --- Phase 9A (docs/mix-transition-phase9.md §3): transition observability ---

test('acceptance (mixer): a committed stem-mix transition emits exactly one [MIX PLAN] report, selected=stem-mix', async () => {
  const frame = Buffer.alloc(FRAME_BYTES);
  new Int16Array(frame.buffer).fill(4000);
  const { outgoingAnalysis, incomingAnalysis } = stemFixtures();

  const logCalls = [];
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
    createFileSourceFn: () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.from(frame))),
    logTransitionPlanFn: (report) => logCalls.push(report),
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
    // Exactly one report for the one committed transition — not one per
    // ~200ms arm-tick re-evaluation that led up to it.
    assert.equal(logCalls.length, 1);
    const report = logCalls[0];
    assert.equal(report.from, 'Track A');
    assert.equal(report.to, 'Track B');
    assert.equal(report.selected, 'stem-mix');
    assert.equal(report.downgradedFrom, null);
    assert.equal(report.candidates.stemMix.eligible, true);
    assert.deepEqual(report.stemCache, { outgoing: 'hit', incoming: 'hit' });
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a natural gapless handoff whose evaluated rawPlan was already gapless is not reported as downgraded from itself (Codex review, PR #43, P2)', async () => {
  // planTransition() returns mode:'gapless' outright when the outgoing
  // analysis has very low confidence (0 < confidence < 0.2) and low vocal
  // confidence — no beatmix/stem-mix/phrase-crossfade was ever eligible, so
  // this pair's stashed report already has selected='gapless' before the
  // hard handoff below even runs.
  const lowConfidenceAnalysis = { version: ANALYSIS_VERSION, confidence: 0.1, vocalConfidence: 0.1, durationSec: 60 };
  const logCalls = [];
  // Under SHORT_TRACK_THRESHOLD_SEC (5s, src/player/playbackPolicy.js) so
  // shouldReconnectRetry() does not replay this same track instead of
  // advancing once triggerTrackEnd() fires below.
  const { player, queue } = makePlayer({
    trackDuration: 3,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 3, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => lowConfidenceAnalysis,
    analyzeTrackFileFn: null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.alloc(FRAME_BYTES))),
    logTransitionPlanFn: (report) => logCalls.push(report),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 3, videoId: 'vid-b' }));

  try {
    await player.playNext();
    // Let at least one 200ms crossfade-arm tick run (and stash its
    // evaluated, already-gapless report) before the track ends naturally.
    await new Promise((resolve) => setTimeout(resolve, 300));
    triggerTrackEnd({ mixStream: player.mixStream });
    await waitMs(50);

    assert.equal(logCalls.length, 1);
    const report = logCalls[0];
    assert.equal(report.selected, 'gapless');
    assert.equal(report.downgradedFrom, null,
      'a rawPlan that was already gapless must not be reported as downgraded from itself');
    // Codex review (PR #43, round 8): entrySec===0 (this hard handoff's
    // native start offset, the ordinary #playNextMixer path never honors a
    // seek) does not mean bar 0 was actually detected/aligned — no bar
    // alignment happened at all on this path.
    assert.equal(report.entry.sec, 0);
    assert.equal(report.entry.bar, null,
      'entrySec===0 must not be reported as bar 0 — a hard handoff performs no bar alignment');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): logTransitionPlan still fires (with the real ladder\'s own selection) when no custom Fn is injected', async () => {
  const { player, queue } = makePlayer({ trackDuration: 3, framesPerTrack: 400 });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 3 }));

  try {
    await player.playNext();
    for (let i = 0; i < 60; i += 1) {
      player.mixStream.read(FRAME_BYTES);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    // No assertion beyond "did not throw" — this exercises the real
    // (non-injected) logTransitionPlan()/buildTransitionPlanReport() wiring
    // end-to-end with only fallbackAnalysis()-grade analysis available
    // (no bpm/vocal data), which every earlier acceptance test in this file
    // bypasses via a custom getTrackAnalysisFn/logTransitionPlanFn.
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

test('acceptance (mixer): an arm tick whose queue advances out from under it (mid-analysis) does not stash a stale evaluation (Codex review, PR #43, P2)', async () => {
  // Codex review (PR #43, round 8): #maybeStartCrossfade() awaits
  // #getCachedAnalysis() (among other things) before stashing its
  // evaluation for the (current, next) pair it captured at the very top of
  // the tick. If the queue advances during that await (a skip, here — a
  // snap handoff racing the same tick is the finding's original scenario,
  // but any queue advance during the await exercises the same staleness
  // window), the captured pair is stale by the time the stash would run.
  // Delaying getTrackAnalysisFn for the CURRENT track (A) reliably parks an
  // arm tick mid-await long enough to skip past it.
  let releaseAnalysis;
  let analysisRequested = false;
  const logCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async (videoId) => {
      if (videoId === 'vid-a') {
        analysisRequested = true;
        return new Promise((resolve) => { releaseAnalysis = () => resolve(null); });
      }
      return null;
    },
    analyzeTrackFileFn: null,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 400 }, () => Buffer.alloc(FRAME_BYTES))),
    logTransitionPlanFn: (report) => logCalls.push(report),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  let startedPlan = null;
  player.mixStream.on('crossfadestart', (plan) => { startedPlan = plan; });

  try {
    await player.playNext();
    await pollUntil(() => analysisRequested, { timeoutMs: 2000 });
    // The arm tick evaluating A (current) / B (next) is now parked inside
    // #getCachedAnalysis(current)'s await. Advance the queue out from
    // under it before releasing that await.
    await player.skip();
    await nextTurn();
    assert.equal(queue.current.videoId, 'vid-b', 'expected skip() to have advanced the queue while the tick was parked');

    releaseAnalysis();
    await waitMs(200); // let the parked tick resume and (correctly) bail out

    assert.equal(startedPlan, null, 'the stale A/B evaluation must never reach a crossfade start');
    assert.ok(
      !logCalls.some((r) => r.from === 'Track A'),
      'a report evaluated for the stale (A, B) pair must never be stashed/logged once A is no longer current',
    );
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

test('acceptance (mixer): a LOW-priority stem prefetch rechecks the cache when its turn on the serial queue actually comes up, skipping the download on a hit (Codex review, PR #44, P2)', async () => {
  // #ensureStemPrefetch() only observes a cache MISS once, when the pair
  // first becomes next/next+1. If another guild (or an earlier HIGH job)
  // separates the same track while this LOW job is still waiting behind
  // other work on the shared serial queue, the recheck inside
  // #runLowPriorityStemPrefetch()'s own enqueued callback must catch that
  // and skip straight to returning the now-cached stems — never spending a
  // full download/trim/loudness/staging pass on a track someone else
  // already finished.
  const cacheCallsPerVideo = new Map();
  const stageCalls = [];
  const separateCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    // stageTempFileCopyFn/separateTrackStemsFn are only ever called from
    // the stem-specific pipeline (#scheduleAnalysis for HIGH,
    // #runLowPriorityStemPrefetch for LOW) — unlike prefetchTrackFn, which
    // the general upcoming-track audio prefetch also calls for C
    // regardless of stem-cache state, so tracking calls to THESE two is
    // what actually isolates "did the stem pipeline redo expensive work".
    stageTempFileCopyFn: async (filePath) => {
      stageCalls.push(filePath);
      return `${filePath}.staged`;
    },
    getCachedStemsFn: async (videoId) => {
      const calls = (cacheCallsPerVideo.get(videoId) ?? 0) + 1;
      cacheCallsPerVideo.set(videoId, calls);
      // vid-c: miss on #ensureStemPrefetch()'s first probe (so the LOW job
      // gets queued), then a hit on every later recheck (simulating
      // another guild finishing separation while this job waited).
      if (videoId === 'vid-c' && calls >= 2) {
        return { vocalPath: '/tmp/vid-c.vocal.wav', instrumentalPath: '/tmp/vid-c.instrumental.wav' };
      }
      return null;
    },
    separateTrackStemsFn: async (filePath, videoId) => {
      separateCalls.push(videoId);
      return { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  try {
    await player.playNext();
    await pollUntil(() => byIdReady(player, 'vid-c'));

    assert.equal(byIdState(player, 'vid-c'), 'ready', 'expected the cache-hit recheck to still mark C ready');
    assert.ok(!stageCalls.some((f) => f.includes('vid-c')),
      'expected the recheck hit to skip staging C\'s downloaded file entirely — no separation work was ever going to run on it');
    assert.ok(!separateCalls.includes('vid-c'),
      'expected the recheck hit to skip separateTrackStemsFn for C entirely — the cached stems were returned directly');
  } finally {
    await player.stop();
  }
});

// --- Phase 9B (docs/mix-transition-phase9.md §4): stem prefetch ----------

test('acceptance (mixer): stem prefetch tracks next=HIGH / next+1=LOW, and separates both on a cache miss', async () => {
  const stemCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async () => null, // always a miss, so real separation dispatches
    separateTrackStemsFn: async (filePath, videoId) => {
      stemCalls.push(videoId);
      return { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));
  queue.add(createTrack({ title: 'Track D', webpageUrl: 'https://example.com/d', duration: 60, videoId: 'vid-d' }));

  try {
    await player.playNext();

    await pollUntil(() => stemCalls.includes('vid-b') && stemCalls.includes('vid-c'));
    assert.ok(stemCalls.includes('vid-b'), 'expected next (B) to be separated');
    assert.ok(stemCalls.includes('vid-c'), 'expected next+1 (C) to also be separated (§4.2 LOW lane)');
    assert.ok(!stemCalls.includes('vid-a'), 'the current track (A) is not this method\'s concern (Phase 8 owns it)');
    assert.ok(!stemCalls.includes('vid-d'), 'next+2 (D) must stay untouched by stem prefetch');

    const byId = Object.fromEntries(player.stemPrefetchStatus.map((e) => [e.videoId, e]));
    assert.equal(byId['vid-b']?.priority, 'high');
    assert.equal(byId['vid-c']?.priority, 'low');
    assert.equal(byId['vid-d'], undefined, 'next+2 must not be tracked at all');

    await pollUntil(() => byIdReady(player, 'vid-b') && byIdReady(player, 'vid-c'));
    assert.equal(byIdState(player, 'vid-b'), 'ready');
    assert.equal(byIdState(player, 'vid-c'), 'ready');
  } finally {
    await player.stop();
  }
});

// --- Phase 9C (docs/mix-transition-phase9.md §5): dedicated stem queue ---

test('acceptance (mixer): #scheduleAnalysis() runs BPM/phrase analysis on the injected realtime queue but dispatches its stem-separation step on the injected stem queue (Phase 9C §5)', async () => {
  // Same "current track has no videoId, so #scheduleAnalysis() only ever
  // fires for the prefetched NEXT track" setup as the pre-existing
  // "stem separation input is staged..." test above — #createPcmSourceFn
  // is overridden (as in every acceptance test in this file), which
  // bypasses the real #createPcmSource()'s own #scheduleAnalysis() call
  // for whichever track is actually current. Routing #scheduleAnalysis()'s
  // separation step onto the stem queue is exercised the same way that
  // test exercises #scheduleAnalysis() at all: via #ensureFullPrefetch()
  // prefetching Track B ahead of playback.
  const frame = Buffer.alloc(FRAME_BYTES);
  const originalFilePath = '/tmp/musicbot-original-vid-9c';
  const stagedFilePath = '/tmp/musicbot-staged-vid-9c';
  const realtimeEnqueues = [];
  const stemEnqueues = [];
  const separateCalls = [];
  const analysis = {
    version: ANALYSIS_VERSION, durationSec: 60, lastVocalEndSec: 50, vocalConfidence: 0.85, confidence: 0.8,
  };
  const realtimeQueue = {
    enqueue: (fn) => {
      realtimeEnqueues.push('enqueue');
      return Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined }));
    },
    noteUnderrun() {},
    noteUnderrunCleared() {},
    kill() {},
  };
  const stemQueue = {
    enqueue: (fn) => {
      stemEnqueues.push('enqueue');
      return Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined }));
    },
    pause() {},
    resume() {},
    kill() {},
  };
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => analysis,
    prefetchTrackFn: async () => ({ filePath: originalFilePath, measured: {} }),
    stageTempFileCopyFn: async () => stagedFilePath,
    separateTrackStemsFn: async (filePath, videoId) => {
      separateCalls.push({ filePath, videoId });
      return { vocalPath: '/tmp/v.wav', instrumentalPath: '/tmp/i.wav' };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => frame)),
    analysisQueue: realtimeQueue,
    stemQueue,
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));

  try {
    await player.playNext();
    await pollUntil(() => separateCalls.length > 0);

    assert.equal(realtimeEnqueues.length, 1, 'expected exactly one realtime-queue job (BPM/phrase analysis)');
    assert.equal(stemEnqueues.length, 1, 'expected exactly one stem-queue job (the Demucs separation step)');
    assert.equal(separateCalls.length, 1);
    assert.equal(separateCalls[0].filePath, stagedFilePath, 'separation must still receive the staged copy, unchanged from before the queue split');
    assert.equal(separateCalls[0].videoId, 'vid-b');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): Phase 9C — next=HIGH (B) and next+1=LOW (C) stem prefetch both dispatch separation on the injected stem queue, never the injected realtime analysis queue', async () => {
  const realtimeEnqueues = [];
  const stemEnqueues = [];
  const stemCalls = [];
  const realtimeQueue = {
    enqueue: (fn) => {
      realtimeEnqueues.push('enqueue');
      return Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined }));
    },
    noteUnderrun() {},
    noteUnderrunCleared() {},
    kill() {},
  };
  const stemQueue = {
    enqueue: (fn) => {
      stemEnqueues.push('enqueue');
      return Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined }));
    },
    pause() {},
    resume() {},
    kill() {},
  };
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-9c-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async () => null, // always a miss, so real separation dispatches
    separateTrackStemsFn: async (filePath, videoId) => {
      stemCalls.push(videoId);
      return { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
    analysisQueue: realtimeQueue,
    stemQueue,
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  try {
    await player.playNext();
    await pollUntil(() => stemCalls.includes('vid-b') && stemCalls.includes('vid-c'));

    assert.ok(stemCalls.includes('vid-b'), 'next (B, HIGH — piggybacks on #scheduleAnalysis) must separate via the stem queue');
    assert.ok(stemCalls.includes('vid-c'), 'next+1 (C, LOW — #runLowPriorityStemPrefetch) must separate via the stem queue');
    assert.equal(stemEnqueues.length, stemCalls.length,
      'expected every separateTrackStemsFn() call to have happened inside exactly one stem-queue job — none dispatched directly, none via the realtime queue');
    // B's HIGH lane piggybacks on #scheduleAnalysis(), which still runs its
    // BPM/phrase analysis step on the realtime queue — only the Demucs step
    // moved. C's LOW lane (#runLowPriorityStemPrefetch) has no analysis
    // step at all, so it contributes nothing here either way. The real
    // assertion is the equality above: every actual separation call landed
    // on the stem queue, none on the realtime one.
    assert.ok(realtimeEnqueues.length >= 1, 'expected B\'s piggybacked #scheduleAnalysis() BPM/phrase step to still use the realtime queue');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): Phase 9C — a mixer underrun debounces into the dedicated stem queue via noteUnderrun(), same as the realtime queue, and underrunClear clears both (Codex review, PR #45, P2)', async () => {
  // Codex review (PR #45, P2): a raw mixer underrun event can be jittery
  // (several isolated one-frame stalls in quick succession) — routing it
  // straight to the stem queue's immediate pause() command (this test's own
  // previous assertion) could rack up pause()'s pauseCount past MAX_PAUSES
  // and kill a long-running Demucs job over transient noise the realtime
  // queue's own noteUnderrun() debounce is built to ignore. Both queues now
  // receive the same debounced signal.
  const realtimeCalls = [];
  const stemCalls = [];
  const realtimeQueue = {
    enqueue: (fn) => fn({ spawnNice: () => {}, signal: undefined }),
    noteUnderrun(source) { realtimeCalls.push(['noteUnderrun', source]); },
    noteUnderrunCleared(source) { realtimeCalls.push(['noteUnderrunCleared', source]); },
    kill() {},
  };
  const stemQueue = {
    enqueue: (fn) => fn({ spawnNice: () => {}, signal: undefined }),
    noteUnderrun(source) { stemCalls.push(['noteUnderrun', source]); },
    noteUnderrunCleared(source) { stemCalls.push(['noteUnderrunCleared', source]); },
    pause() { stemCalls.push(['pause']); },
    resume() { stemCalls.push(['resume']); },
    kill() {},
  };
  const { player } = makePlayer({ analysisQueue: realtimeQueue, stemQueue });

  player.mixStream.emit('underrun');
  assert.equal(realtimeCalls.filter(([name]) => name === 'noteUnderrun').length, 1,
    'expected the realtime queue to receive its own debounced noteUnderrun() signal');
  assert.equal(stemCalls.filter(([name]) => name === 'noteUnderrun').length, 1,
    'expected the mixer underrun to forward the SAME debounced noteUnderrun() signal to the stem-preparation queue');
  assert.equal(stemCalls.some(([name]) => name === 'pause'), false,
    'the stem queue must be paused via its own debounced noteUnderrun() API, not the immediate pause() command');

  player.mixStream.emit('underrunClear');
  assert.equal(realtimeCalls.filter(([name]) => name === 'noteUnderrunCleared').length, 1);
  assert.equal(stemCalls.filter(([name]) => name === 'noteUnderrunCleared').length, 1,
    'expected underrunClear to clear the stem queue via noteUnderrunCleared() too');

  await player.stop();
});

test('acceptance (mixer): Phase 9C — skip() releases this player\'s stem-queue pause source even mid-underrun (Codex review, PR #45, P1)', async () => {
  const stemCalls = [];
  const stemQueue = {
    enqueue: (fn) => fn({ spawnNice: () => {}, signal: undefined }),
    noteUnderrun(source) { stemCalls.push(['noteUnderrun', source]); },
    noteUnderrunCleared(source) { stemCalls.push(['noteUnderrunCleared', source]); },
    resume(source) { stemCalls.push(['noteUnderrunCleared', source]); },
    kill() {},
  };
  const { player, queue } = makePlayer({ trackDuration: 60, stemQueue });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }));

  await player.playNext();
  player.mixStream.emit('underrun'); // simulate a pause source registered mid-underrun
  stemCalls.length = 0;

  await player.skip();
  assert.equal(stemCalls.filter(([name, source]) => name === 'noteUnderrunCleared' && source === player).length, 1,
    'skip() must release this player\'s stem-queue pause source, not leave the shared queue stuck paused for other guilds');

  await player.stop();
});

test('acceptance (mixer): Phase 9C — disconnecting without an explicit stop() (e.g. queue exhaustion) still releases the stem-queue pause source (Codex review, PR #45, P1)', async () => {
  // Several normal paths (queue exhaustion with no autoplay handler, among
  // others) call the injected onDisconnect callback directly, bypassing
  // stop()'s own cleanup entirely — the #disconnect() wrapper this
  // regression test targets exists specifically to close that gap.
  const stemCalls = [];
  const stemQueue = {
    enqueue: (fn) => fn({ spawnNice: () => {}, signal: undefined }),
    noteUnderrun(source) { stemCalls.push(['noteUnderrun', source]); },
    noteUnderrunCleared(source) { stemCalls.push(['noteUnderrunCleared', source]); },
    resume(source) { stemCalls.push(['noteUnderrunCleared', source]); },
    kill() {},
  };
  let disconnected = false;
  const { player } = makePlayer({
    trackDuration: 3,
    stemQueue,
    onDisconnect: async () => { disconnected = true; },
  });

  await player.playNext();
  player.mixStream.emit('underrun');
  stemCalls.length = 0;

  triggerTrackEnd({ mixStream: player.mixStream }); // queue exhausted, no handler -> disconnect
  await waitMs(20);

  assert.equal(disconnected, true, 'expected the queue-exhaustion path to disconnect');
  assert.equal(stemCalls.filter(([name, source]) => name === 'noteUnderrunCleared' && source === player).length, 1,
    'the #disconnect() wrapper must release the stem-queue pause source even though stop() was never called');
});

// --- Codex review (PR #45 round 2): retry a HIGH stem separation the stem queue itself killed ---

test('acceptance (mixer): a stem-queue-level ANALYSIS_KILLED on the HIGH (next-track) job is retried once, not treated as a permanent failure', async () => {
  // The realtime #analysisQ() job that dispatches separation resolves
  // immediately (the stem-queue dispatch is deliberately not awaited), so
  // by the time the stem queue itself kills the separation job (e.g. its
  // own maxPauses/maxStoppedMs machinery preempting it mid-underrun), the
  // outer #scheduleAnalysis().catch()'s own ANALYSIS_KILLED retry has
  // already run its course and won't fire again for this rejection.
  const analysis = {
    version: ANALYSIS_VERSION, durationSec: 60, lastVocalEndSec: 50, vocalConfidence: 0.85, confidence: 0.8,
  };
  let stemAttempt = 0;
  const separateCalls = [];
  const stageCalls = [];
  const realtimeQueue = {
    enqueue: (fn) => Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined })),
    noteUnderrun() {}, noteUnderrunCleared() {}, kill() {},
  };
  const stemQueue = {
    enqueue: (fn) => {
      stemAttempt += 1;
      if (stemAttempt === 1) {
        // Simulate the stem queue's own kill machinery preempting this job.
        const err = new Error('analysis killed');
        err.code = 'ANALYSIS_KILLED';
        return Promise.reject(err);
      }
      return Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined }));
    },
    noteUnderrun() {}, noteUnderrunCleared() {}, resume() {}, kill() {},
  };
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => analysis,
    // Codex review (PR #45, P2, round 2): by the time a stem-queue-level
    // kill retries, `filePath` (the original normalized file) may already
    // be gone via unrelated track promotion/end cleanup — returning a
    // path here that no later step actually revisits (the retry must
    // reuse the already-staged copy, not re-stage/re-download from this)
    // is exactly what proves the fix doesn't depend on it still existing.
    prefetchTrackFn: async () => ({ filePath: '/tmp/musicbot-9c-retry-original', measured: {} }),
    stageTempFileCopyFn: async (filePath) => {
      stageCalls.push(filePath);
      return `${filePath}.staged`;
    },
    getCachedStemsFn: async () => null,
    separateTrackStemsFn: async (filePath, videoId) => {
      separateCalls.push({ filePath, videoId });
      return { vocalPath: '/tmp/v.wav', instrumentalPath: '/tmp/i.wav' };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
    analysisQueue: realtimeQueue,
    stemQueue,
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b-retry' }));

  try {
    await player.playNext();
    await pollUntil(() => separateCalls.length > 0);

    assert.equal(stemAttempt, 2, 'expected exactly one retry after the stem-queue-level kill');
    assert.equal(separateCalls.length, 1, 'the retried attempt must actually reach separation');
    assert.equal(separateCalls[0].videoId, 'vid-b-retry');
    assert.equal(stageCalls.length, 1,
      'the retry must reuse the already-staged copy, not call stageTempFileCopyFn (re-stage from filePath) again');
    assert.equal(separateCalls[0].filePath, '/tmp/musicbot-9c-retry-original.staged',
      'the retry must separate from the exact same staged file the killed first attempt used');
    assert.equal(byIdState(player, 'vid-b-retry'), 'ready');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): the stem-queue-level kill retry waits for the killed separateTrackStemsFn call to actually settle before dispatching the replacement (Codex review, PR #45, P2, round 3)', async () => {
  // Codex review round 3: the production separateTrackStems() (stemCache.js)
  // dedups per-videoId via its own module-level `inFlight` Map, cleared
  // only once that specific call's own promise settles — the stem queue's
  // kill only rejects the OUTER race (analysisQueue.js's pump()), it does
  // not cancel or clear this inner call. Dispatching the retry immediately
  // (instead of waiting for that inner promise) would just hit the same
  // dedup check and get back the same doomed (killed -> resolves null)
  // promise, silently burning the one retry for nothing. This mock
  // reproduces that dedup shape directly, unlike the round-2 test's
  // stemQueue mock (which never even invoked the job callback on the
  // killed first attempt, so it couldn't have caught this).
  const analysis = {
    version: ANALYSIS_VERSION, durationSec: 60, lastVocalEndSec: 50, vocalConfidence: 0.85, confidence: 0.8,
  };
  let enqueueCalls = 0;
  let realSeparationStarts = 0;
  const inFlightSim = new Map();
  const separateTrackStemsFn = async (filePath, videoId) => {
    if (inFlightSim.has(videoId)) return inFlightSim.get(videoId);
    realSeparationStarts += 1;
    const isFirstAttempt = realSeparationStarts === 1;
    const attempt = (async () => {
      await waitMs(50); // simulates the time until the killed subprocess's exit event actually arrives
      // The first (killed) attempt's own runSeparation() catches the SIGKILL
      // failure and resolves null; a genuinely fresh retry (not hitting the
      // dedup) succeeds normally.
      return isFirstAttempt ? null : { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` };
    })().finally(() => inFlightSim.delete(videoId));
    inFlightSim.set(videoId, attempt);
    return attempt;
  };
  const realtimeQueue = {
    enqueue: (fn) => Promise.resolve().then(() => fn({ spawnNice: () => {}, signal: undefined })),
    noteUnderrun() {}, noteUnderrunCleared() {}, kill() {},
  };
  const stemQueue = {
    enqueue: (fn) => {
      enqueueCalls += 1;
      // Mirrors analysisQueue.js's pump(): the job callback actually runs
      // (starting the real separateTrackStemsFn call), but on the first
      // attempt the OUTER promise this enqueue() call returns is raced
      // away by an immediate kill rejection, same as Promise.race() there
      // — the inner `workPromise` is never cancelled, just abandoned.
      const workPromise = fn({ spawnNice: () => {}, signal: undefined });
      if (enqueueCalls === 1) {
        const err = new Error('analysis killed');
        err.code = 'ANALYSIS_KILLED';
        return Promise.reject(err);
      }
      return workPromise;
    },
    noteUnderrun() {}, noteUnderrunCleared() {}, resume() {}, kill() {},
  };
  const { player, queue } = makePlayer({
    trackDuration: 60,
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => analysis,
    prefetchTrackFn: async () => ({ filePath: '/tmp/musicbot-9c-retry3-original', measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async () => null,
    separateTrackStemsFn,
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
    analysisQueue: realtimeQueue,
    stemQueue,
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b-retry3' }));

  try {
    await player.playNext();
    await pollUntil(() => byIdState(player, 'vid-b-retry3') === 'ready', { timeoutMs: 3000 });

    assert.equal(realSeparationStarts, 2,
      'expected the retry to start a genuinely fresh separateTrackStemsFn call, not reuse the killed attempt\'s doomed dedup entry');
    assert.equal(byIdState(player, 'vid-b-retry3'), 'ready');
  } finally {
    await player.stop();
  }
});

function byIdState(player, videoId) {
  return player.stemPrefetchStatus.find((e) => e.videoId === videoId)?.state ?? null;
}

function byIdReady(player, videoId) {
  return byIdState(player, videoId) === 'ready';
}

test('acceptance (mixer): a stem-cache hit marks next/next+1 READY without a redundant separation call', async () => {
  const stemCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async (videoId) => ({
      vocalPath: `/tmp/${videoId}.vocal.wav`,
      instrumentalPath: `/tmp/${videoId}.instrumental.wav`,
    }),
    separateTrackStemsFn: async (filePath, videoId) => {
      stemCalls.push(videoId);
      return { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  try {
    await player.playNext();
    await pollUntil(() => byIdReady(player, 'vid-b') && byIdReady(player, 'vid-c'));

    assert.equal(byIdState(player, 'vid-b'), 'ready');
    assert.equal(byIdState(player, 'vid-c'), 'ready');
    assert.equal(stemCalls.filter((id) => id === 'vid-c').length, 0,
      'a stem-cache HIT for C must not also trigger the LOW-priority separation pipeline');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a READY entry is not sticky — a later cache eviction is re-detected the next time the pair is re-probed (Codex review, PR #44, round 3, P2)', async () => {
  // pruneStemCache() (src/audio/stemCache.js) can evict a previously
  // separated pair's files under the shared cache's size cap, driven by
  // unrelated guilds' separations — nothing tells this tracker that its
  // READY entry has gone stale. #ensureStemPrefetch() used to skip its own
  // getCachedStemsFn() probe entirely once an entry reached READY, so a
  // pair evicted while still sitting in the next/next+1 window would report
  // READY forever and never regenerate.
  //
  // A second #prefetchUpcoming() checkpoint over the SAME still-queued B/C
  // pair (here: calling playNext() again without anything actually
  // advancing) is what gives C's already-READY entry a second
  // #ensureStemPrefetch() probe while it's still un-pruned (prune() only
  // drops entries once they leave the next/next+1 window entirely) — the
  // cache answers MISS this time, simulating eviction.
  let cacheCallsForC = 0;
  let separateCallsForC = 0;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async (videoId) => {
      if (videoId !== 'vid-c') return null;
      cacheCallsForC += 1;
      if (cacheCallsForC === 1) {
        return { vocalPath: '/tmp/vid-c.vocal.wav', instrumentalPath: '/tmp/vid-c.instrumental.wav' };
      }
      return null; // every later probe: evicted
    },
    separateTrackStemsFn: async (filePath, videoId) => {
      if (videoId === 'vid-c') separateCallsForC += 1;
      return { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` };
    },
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  try {
    await player.playNext();
    await pollUntil(() => byIdReady(player, 'vid-c'));
    assert.equal(byIdState(player, 'vid-c'), 'ready', 'expected the initial cache hit to mark C ready while still next+1');
    assert.equal(cacheCallsForC, 1);
    const readyEntry = player.stemPrefetchStatus.find((e) => e.videoId === 'vid-c');
    assert.equal(readyEntry.startedAt, null, 'sanity check: no separation ran yet — the cache hit alone marked it ready');

    // Nothing in the queue advances — this only re-runs the same
    // #prefetchUpcoming() checkpoint over the same still-next/next+1 B/C
    // pair, so any recovery observed below can only come from
    // #ensureStemPrefetch() itself noticing the now-evicted cache, not from
    // Phase 8's independent full-prefetch pipeline (which only ever fires
    // once per track, when it first becomes `next`).
    await player.playNext();
    await nextTurn();

    const recoveredSeparation = await pollUntil(() => separateCallsForC >= 1, { timeoutMs: 3000 });
    assert.ok(recoveredSeparation,
      'expected a fresh separateTrackStemsFn call for C once the stale cache hit was detected as a miss');
    assert.ok(cacheCallsForC >= 2,
      'expected #ensureStemPrefetch to re-probe the cache for C even though it was already marked ready — READY must not be sticky');

    const recoveredReady = await pollUntil(() => byIdReady(player, 'vid-c'), { timeoutMs: 5000 });
    assert.ok(recoveredReady,
      'expected C to recover back to ready via a fresh separation, not stay stuck reporting stale ready');
    const finalEntry = player.stemPrefetchStatus.find((e) => e.videoId === 'vid-c');
    assert.notEqual(finalEntry.startedAt, null,
      'expected a genuine re-separation (startedAt stamped) rather than the original stale ready being left untouched');
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a skip promoting C to next escalates its stem prefetch priority to HIGH', async () => {
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async () => null,
    separateTrackStemsFn: async (filePath, videoId) => (
      { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` }
    ),
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  try {
    await player.playNext();
    await pollUntil(() => player.stemPrefetchStatus.some((e) => e.videoId === 'vid-c'));
    assert.equal(
      player.stemPrefetchStatus.find((e) => e.videoId === 'vid-c')?.priority,
      'low',
      'expected C to start out LOW while B is still next',
    );

    // player.skip() (not triggerTrackEnd) so #forceSkip bypasses the
    // reconnect-retry grace window (RECONNECT_GRACE_MS) entirely — this
    // promotion shifts C from next+1 to next, and #prefetchUpcoming()
    // re-runs as part of it.
    await player.skip();
    await nextTurn();
    assert.equal(queue.current.videoId, 'vid-b');

    await pollUntil(() => player.stemPrefetchStatus.find((e) => e.videoId === 'vid-c')?.priority === 'high');
    assert.equal(
      player.stemPrefetchStatus.find((e) => e.videoId === 'vid-c')?.priority,
      'high',
      'expected C to be escalated to HIGH once it became next',
    );
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a track removed from the queue is pruned from stem prefetch after its attempt settles', async () => {
  let resolveC;
  let cCacheCalls = 0;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async (videoId) => {
      // Codex review (PR #44, P2): #runLowPriorityStemPrefetch() now
      // rechecks the cache itself once its job actually starts, a SECOND
      // call for 'vid-c' beyond #ensureStemPrefetch()'s own initial probe.
      // Only the first call should hang on the manually-resolved promise
      // below (that's the one this test controls) — later calls answer
      // immediately with a miss, or the second call would hang forever on
      // a `resolveC` nothing calls again, wedging the real shared
      // analysisQueue singleton for every later test in this file.
      if (videoId === 'vid-c' && cCacheCalls === 0) {
        cCacheCalls += 1;
        return new Promise((resolve) => { resolveC = resolve; });
      }
      if (videoId === 'vid-c') cCacheCalls += 1;
      return null;
    },
    separateTrackStemsFn: async (filePath, videoId) => (
      { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` }
    ),
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));
  queue.add(createTrack({ title: 'Track C', webpageUrl: 'https://example.com/c', duration: 60, videoId: 'vid-c' }));

  try {
    await player.playNext();
    await pollUntil(() => resolveC != null); // C's cache check has started (dispatched from #ensureStemPrefetch)
    assert.ok(player.stemPrefetchStatus.some((e) => e.videoId === 'vid-c'), 'expected C to be tracked while still next+1');

    // Remove C from the queue entirely (an unrelated /remove-style
    // mutation, bypassing the player — see queue.js's removeUpcoming())
    // while its cache check is still pending.
    queue.removeUpcoming(1);
    assert.deepEqual(queue.upcoming().map((t) => t.videoId), ['vid-b']);

    resolveC(null); // the pending getCachedStemsFn() call for C finally resolves (a miss)
    await nextTurn();
    await pollUntil(() => byIdState(player, 'vid-c') != null && byIdState(player, 'vid-c') !== 'processing');
    assert.equal(byIdState(player, 'vid-c'), 'ready', 'the LOW pipeline dispatched before removal still completes (no cancellation API)');

    // The next #prefetchUpcoming() checkpoint (B being promoted to current)
    // prunes it, now that it has reached a terminal state and is no longer
    // in the active window. player.skip() bypasses the reconnect-retry
    // grace window so this promotion happens immediately.
    await player.skip();
    await nextTurn();
    assert.ok(
      !player.stemPrefetchStatus.some((e) => e.videoId === 'vid-c'),
      'expected the stale entry to be pruned once it left the active window and reached a terminal state',
    );
  } finally {
    await player.stop();
  }
});

test('acceptance (mixer): a HIGH stem job killed by ANALYSIS_KILLED after a successful download gets retried once (Codex review, PR #44)', async () => {
  // #ensureFullPrefetch()'s own .then() calls #scheduleAnalysis() exactly
  // once, right when B's download resolves. If that one attempt gets
  // preempted (ANALYSIS_KILLED — a real-time-pressure abort, e.g. a mixer
  // underrun), nothing else would ever retry it without the fix — the
  // tracker would stay FAILED forever even though the download itself
  // succeeded and B is still next. A clean `null` from separateTrackStemsFn
  // (a genuine "no separable stems" outcome, exercised by the older Phase 8
  // "stem separation input is staged..." tests) must NOT be retried —
  // that's still a one-shot attempt.
  let analyzeCallsForB = 0;
  const { player, queue } = makePlayer({
    trackDuration: 60,
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a' }),
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async (filePath, { videoId } = {}) => {
      if (videoId === 'vid-b') {
        analyzeCallsForB += 1;
        if (analyzeCallsForB === 1) {
          const err = new Error('simulated ANALYSIS_KILLED preemption');
          err.code = 'ANALYSIS_KILLED';
          throw err;
        }
      }
      return null;
    },
    prefetchTrackFn: async (track) => ({ filePath: `/tmp/musicbot-prefetch-${track.videoId}`, measured: {} }),
    stageTempFileCopyFn: async (filePath) => `${filePath}.staged`,
    getCachedStemsFn: async () => null,
    separateTrackStemsFn: async (filePath, videoId) => (
      { vocalPath: `/tmp/${videoId}.vocal.wav`, instrumentalPath: `/tmp/${videoId}.instrumental.wav` }
    ),
    createPcmSourceFn: async () => PcmSource.fromBuffers(Array.from({ length: 10 }, () => Buffer.alloc(FRAME_BYTES))),
  });
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b' }));

  try {
    await player.playNext();
    await pollUntil(() => byIdState(player, 'vid-b') === 'ready', { timeoutMs: 5000 });
    assert.equal(byIdState(player, 'vid-b'), 'ready');
    assert.ok(analyzeCallsForB >= 2, 'expected a retried analysis/separation attempt after the ANALYSIS_KILLED preemption');
  } finally {
    await player.stop();
  }
});

// --- Phase 9A round 4 (Codex review, PR #43): #pendingGaplessFrom staleness ---

test('acceptance (mixer): stop() clears a pending gapless continuation so a later unrelated playNext does not misattribute it', async () => {
  const logCalls = [];
  const { player, queue } = makePlayer({
    trackDuration: 3,
    handleQueueExhausted: async () => true, // recommend mode: don't start another track
    logTransitionPlanFn: (report) => logCalls.push(report),
    logGaplessTransitionFn: (payload) => logCalls.push(payload),
  });

  await player.playNext();
  triggerTrackEnd({ mixStream: player.mixStream });
  await waitMs(20);
  // Queue is empty and handleQueueExhausted returned true without adding a
  // track — #pendingGaplessFrom is stashed for whenever playback resumes.

  await player.stop();

  // A later, wholly unrelated /play — nothing here should attribute back
  // to the track that finished before stop().
  queue.add(createTrack({ title: 'Track Z', webpageUrl: 'https://example.com/z', duration: 3 }));
  await player.playNext();
  await waitMs(20);

  assert.equal(logCalls.length, 0, 'stop() must clear the stashed continuation, not let it leak into an unrelated later playNext');
  await player.stop();
});
