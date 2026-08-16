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

test('acceptance (mixer): re-prepping the same incoming track for a beatmix plan reuses the already-downloaded file', async () => {
  // Codex round-2: #ensureIncomingPrep's mismatch-triggered re-prep must not
  // delete and re-fetch a file the eager default prep already downloaded —
  // exercises the REAL #createPcmSource normalize pipeline (no
  // createPcmSourceFn override), so prefetchTrackFn/createFileSource really
  // run against an on-disk file.
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
    // wall-clock time.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(prefetchCalls, 1, 'expected the eager default prep to fetch Track B once');

    // remaining (8s) is already inside the beatmix plan's prepWindow from the
    // very first arm tick (fadeSec + CROSSFADE_PREP_LEAD_SEC = 19s), so the
    // re-prep decision — reuse vs re-fetch — happens on the first tick after
    // playNext, well before positionSec would ever reach the plan's
    // exitStartSec. No need to drive frames through a full crossfade to
    // observe it; just give the 200ms arm timer a couple of ticks.
    await new Promise((resolve) => setTimeout(resolve, 600));

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
