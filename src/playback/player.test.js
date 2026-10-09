import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPlayerStatus, NoSubscriberBehavior, StreamType } from '@discordjs/voice'
import { createTrack, GuildQueue } from './queue.js'
import { QueueAdvancement } from './player/queueAdvancement.js'
import { triggerTrackEnd } from './player/playbackDrive.js'
import { makePlayer, makeAudioPlayer, nextTurn, makePendingPcmSource, deliverPcm } from './player/test-helpers.js'
import {
  ANALYSIS_VERSION,
} from '../audio/trackAnalysis.js'
import {
  MIXER_AUDIO_PLAYER_OPTIONS,
  MIXER_AUDIO_RESOURCE_OPTIONS,
  MIXER_MAX_MISSED_FRAMES,
} from './player.js'

// --- Phase 7B §8.4: session tempo bookkeeping. Phase 7D wires an actual
// stretch (beatmix promotion) into it — see player.acceptance.test.js's
// "beatmix transition..." test for the full crossfade-driven version; the
// test below only exercises the reset-to-native path these tests already
// cover, unchanged. ------------------------------------------------------

test('GuildPlayer.sessionTempo starts unstretched with no known BPM', () => {
  const { player } = makePlayer()

  assert.deepEqual(player.sessionTempo, { nativeBpm: null, playbackBpm: null, tempoRatio: 1 })
})

test('GuildPlayer.sessionTempo resets to a fresh native state for each new current track', async () => {
  const trackA = createTrack({
    title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60, videoId: 'vid-a',
  })
  const trackB = createTrack({
    title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60, videoId: 'vid-b',
  })
  const { player, queue } = makePlayer({ track: trackA })

  await player.playNext()
  await nextTurn()
  const afterA = player.sessionTempo
  assert.deepEqual(afterA, { nativeBpm: null, playbackBpm: null, tempoRatio: 1 })

  await player.stop()
  queue.add(trackB)
  await player.playNext()
  await nextTurn()
  const afterB = player.sessionTempo
  assert.deepEqual(afterB, { nativeBpm: null, playbackBpm: null, tempoRatio: 1 })
  assert.notEqual(afterA, afterB, 'each new current track gets a freshly reset session tempo object')

  await player.stop()
})

test('GuildPlayer.sessionTempo backfills nativeBpm/playbackBpm from cached analysis, read independently per track', async () => {
  // No duration on the track itself: #resolvePlaybackDurationSec then has
  // nothing to fall back to, so mixStream.remainingSec stays null and the
  // crossfade arm timer's `if (remaining == null) await
  // this.#getCachedAnalysis(current)` branch actually runs — that call is
  // what reaches #maybeApplyAnalysisDuration and backfills nativeBpm.
  const trackA = createTrack({
    title: 'Track A', webpageUrl: 'https://example.com/a', videoId: 'vid-a',
  })
  const trackB = createTrack({
    title: 'Track B', webpageUrl: 'https://example.com/b', videoId: 'vid-b',
  })
  const analysisByVideoId = {
    'vid-a': { version: ANALYSIS_VERSION, durationSec: 60, bpm: 120 },
    'vid-b': { version: ANALYSIS_VERSION, durationSec: 60, bpm: 95 },
  }
  const { player, queue } = makePlayer({
    track: trackA,
    // Long enough that the 2-frame default source doesn't end (and advance
    // the queue) before the crossfade arm timer has a chance to fire.
    framesPerTrack: 300,
    getTrackAnalysisFn: async (videoId) => analysisByVideoId[videoId] ?? null,
  })

  // CROSSFADE_ARM_INTERVAL_MS is 200ms; wait past it.
  await player.playNext()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(player.sessionTempo, { nativeBpm: 120, playbackBpm: 120, tempoRatio: 1 })

  await player.stop()
  queue.add(trackB)
  await player.playNext()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.deepEqual(player.sessionTempo, { nativeBpm: 95, playbackBpm: 95, tempoRatio: 1 })

  await player.stop()
})

test('GuildPlayer.status reflects the audio player state', () => {
  const { player, audioPlayer } = makePlayer()

  assert.equal(player.status, AudioPlayerStatus.Idle)
  audioPlayer.state = { status: AudioPlayerStatus.Playing }
  assert.equal(player.status, AudioPlayerStatus.Playing)
})

test('GuildPlayer.playNext plays the mixer resource as StreamType.Raw', async () => {
  const { player, audioPlayer, resources } = makePlayer()

  await player.playNext()

  assert.equal(audioPlayer.resource, resources[0])
  assert.deepEqual(resources[0].options, MIXER_AUDIO_RESOURCE_OPTIONS)

  await player.stop()
})

test('GuildPlayer pipelines MixStream only after a PCM source is attached', async () => {
  const { player, resources } = makePlayer()

  assert.equal(resources.length, 0, 'constructor must not opus-pipeline an empty MixStream')
  await player.playNext()
  assert.equal(resources.length, 1)
  assert.equal(resources[0].stream, player.mixStream)
  assert.ok(player.mixStream.currentSource, 'opus pipeline must start after setCurrent')

  await player.stop()
})

test('GuildPlayer does not opus-pipeline until the PCM source has data', async () => {
  let source
  const { player, resources } = makePlayer({
    createPcmSourceFn: async () => {
      source = makePendingPcmSource()
      return source
    },
  })

  const playing = player.playNext()
  await nextTurn()
  assert.equal(resources.length, 0, 'must not pipeline before ffmpeg/yt-dlp produces PCM')
  assert.equal(player.mixStream.currentSource, null, 'must not setCurrent on an empty decoder')

  source.emit('data')
  await nextTurn()
  assert.equal(resources.length, 0, 'EOF-style data with available=0 is not buffered PCM')
  assert.equal(player.mixStream.currentSource, null)

  deliverPcm(source)
  await playing

  assert.equal(resources.length, 1)
  assert.ok(player.mixStream.currentSource)

  await player.stop()
})

test('GuildPlayer cancels a pending PCM wait when skip supersedes playback', async () => {
  const { PcmSource } = await import('../audio/pcmSource.js')
  const { FRAME_BYTES } = await import('../audio/fade.js')
  const started = []
  let sourceCount = 0
  const first = createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', videoId: 'vid-a' })
  const second = createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', videoId: 'vid-b' })
  const { player, queue, resources } = makePlayer({
    track: first,
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => {
      sourceCount += 1
      if (sourceCount > 1) return PcmSource.fromBuffers([Buffer.alloc(FRAME_BYTES)])
      return makePendingPcmSource()
    },
  })
  queue.add(second)

  const abandonedPlay = player.playNext()
  await nextTurn()
  await player.skip()
  await abandonedPlay
  for (let i = 0; i < 10 && started.length === 0; i += 1) await nextTurn()

  assert.deepEqual(started, ['vid-b'])
  assert.equal(queue.current, second)
  assert.equal(resources.length, 1, 'the abandoned track must not start the opus pipeline')

  await player.stop()
})

test('GuildPlayer treats a PCM wait timeout as a startup failure', async () => {
  const disconnected = []
  const started = []
  const { player, resources } = makePlayer({
    pcmWaitTimeoutMs: 30,
    onDisconnect: async () => { disconnected.push(1) },
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => makePendingPcmSource(),
  })

  await player.playNext()
  for (let i = 0; i < 20 && disconnected.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.equal(resources.length, 0, 'timeout must not attach the opus pipeline')
  assert.deepEqual(started, [])
  assert.equal(disconnected.length, 1)
})

test('GuildPlayer treats EOF without buffered PCM as a startup failure', async () => {
  const disconnected = []
  const started = []
  let source
  const { player, resources } = makePlayer({
    onDisconnect: async () => { disconnected.push(1) },
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => {
      source = makePendingPcmSource()
      return source
    },
  })

  const playing = player.playNext()
  await nextTurn()
  source.emit('data')
  source.ended = true
  source.emit('end')
  await playing
  for (let i = 0; i < 20 && disconnected.length === 0; i += 1) await nextTurn()

  assert.equal(resources.length, 0)
  assert.deepEqual(started, [])
  assert.equal(disconnected.length, 1)
})

test('GuildPlayer honors pause while waiting for the first PCM', async () => {
  const started = []
  let source
  const { player, audioPlayer, resources } = makePlayer({
    track: createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', videoId: 'vid-a' }),
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => {
      source = makePendingPcmSource()
      return source
    },
  })

  const playing = player.playNext()
  await nextTurn()
  assert.equal(player.pause(), true, 'pause during PCM wait must succeed')
  deliverPcm(source)
  await playing

  assert.ok(player.mixStream.currentSource)
  assert.equal(resources.length, 0, 'paused startup must not play() the mixer')
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Idle)
  assert.deepEqual(started, ['vid-a'])

  assert.equal(player.resume(), true)
  assert.equal(resources.length, 1)
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing)

  await player.stop()
})

test('GuildPlayer cancels a pending PCM wait when stop tears the session down', async () => {
  const started = []
  let source
  const { player, resources } = makePlayer({
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => {
      source = makePendingPcmSource()
      return source
    },
  })

  const playing = player.playNext()
  await nextTurn()
  await player.stop()
  deliverPcm(source)
  await playing

  assert.equal(resources.length, 0)
  assert.deepEqual(started, [])
})

test('GuildPlayer cancels a pending PCM wait when the voice connection is destroyed', async () => {
  const { EventEmitter } = await import('node:events')
  const { VoiceConnectionStatus } = await import('@discordjs/voice')
  const started = []
  let source
  const connection = new EventEmitter()
  connection.subscribe = () => {}
  const { player, resources } = makePlayer({
    connection,
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => {
      source = makePendingPcmSource()
      return source
    },
  })

  const playing = player.playNext()
  await nextTurn()
  connection.emit('stateChange', { status: VoiceConnectionStatus.Ready }, { status: VoiceConnectionStatus.Destroyed })
  deliverPcm(source)
  await playing

  assert.equal(resources.length, 0)
  assert.deepEqual(started, [])
})

test('mixer AudioPlayer pauses without a ready subscriber and survives encoder hiccups', () => {
  assert.equal(MIXER_AUDIO_PLAYER_OPTIONS.behaviors.noSubscriber, NoSubscriberBehavior.Pause)
  assert.equal(MIXER_AUDIO_PLAYER_OPTIONS.behaviors.maxMissedFrames, MIXER_MAX_MISSED_FRAMES)
  assert.ok(MIXER_MAX_MISSED_FRAMES > 5)
  assert.equal(MIXER_AUDIO_RESOURCE_OPTIONS.silencePaddingFrames, 0)
  assert.equal(MIXER_AUDIO_RESOURCE_OPTIONS.inputType, StreamType.Raw)
})

test('GuildPlayer: playNext calls onTrackStart with the track videoId', async () => {
  const calls = []
  const track = createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    requestedById: 'discord-123',
    videoId: 'vid-1',
  })
  const { player } = makePlayer({ onTrackStart: (videoId) => calls.push(videoId), track })

  await player.playNext()

  assert.deepEqual(calls, ['vid-1'])

  await player.stop()
})

test('GuildPlayer: a playNext issued during stop() teardown abandons instead of reviving', async () => {
  const started = []
  const { player, resources } = makePlayer({
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => makePendingPcmSource(),
  })

  const stopping = player.stop()
  assert.equal(player.isStopping, true)
  // Issued inside the teardown window: it must not survive stop()'s tail
  // (which endMixer()s the very stream a fresh setCurrent would land on).
  await player.playNext()
  await stopping

  assert.equal(player.isStopping, false)
  assert.equal(resources.length, 0)
  assert.deepEqual(started, [])
})

test('GuildPlayer: a playNext overtaken by stop() mid-prep abandons without disconnecting', async () => {
  const started = []
  let disconnected = false
  let releaseSource
  const sourceReady = new Promise((resolve) => { releaseSource = resolve })
  const { player, resources } = makePlayer({
    onDisconnect: async () => { disconnected = true },
    onTrackStart: (videoId) => started.push(videoId),
    createPcmSourceFn: async () => {
      await sourceReady
      return makePendingPcmSource()
    },
  })

  const playing = player.playNext()
  await nextTurn()
  await player.stop()   // clears the queue + bumps the stop generation
  releaseSource()       // the in-flight prep only resolves after the stop
  await playing

  // Pre-fix this fell into the no-current disconnect path, turning a plain
  // /stop into a session-destroying disconnect. stop() owns teardown now.
  assert.equal(disconnected, false)
  assert.equal(resources.length, 0)
  assert.deepEqual(started, [])
})

test('GuildPlayer: a prep failure overtaken by stop() does not kick the advancement drain', async () => {
  let disconnected = false
  let exhaustionCalls = 0
  let rejectPrep
  const prepFailed = new Promise((_, reject) => { rejectPrep = reject })
  const { player } = makePlayer({
    onDisconnect: async () => { disconnected = true },
    handleQueueExhausted: async () => { exhaustionCalls += 1; return false },
    createPcmSourceFn: () => prepFailed,
  })

  const playing = player.playNext()
  await nextTurn()
  await player.stop()
  rejectPrep(new Error('prep failed'))
  await playing
  await nextTurn()

  // Without the overtake guard the catch path would kick
  // advanceAfterPlayback → empty queue → exhaustion refill → disconnect.
  assert.equal(exhaustionCalls, 0)
  assert.equal(disconnected, false)
})

test('GuildPlayer: a new playNext after stop() completes is not torn down by the finished stop', async () => {
  const started = []
  const { player, audioPlayer, queue } = makePlayer({
    onTrackStart: (videoId) => started.push(videoId),
  })

  await player.stop()
  assert.equal(player.isStopping, false)
  assert.equal(queue.isEmpty, true)

  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    videoId: 'vid-b',
  }))
  await player.playNext()

  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing)
  assert.equal(queue.current.title, 'Track B')
  assert.deepEqual(started, ['vid-b'])

  await player.stop()
})

test('GuildPlayer: stop() then a newly queued track can play', async () => {
  const started = []
  const first = createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    videoId: 'vid-a',
  })
  const { player, audioPlayer, queue, resources } = makePlayer({
    track: first,
    onTrackStart: (videoId) => started.push(videoId),
  })

  await player.playNext()
  const mixerAfterFirstPlay = player.mixStream
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing)

  await player.stop()
  assert.equal(queue.isEmpty, true)
  assert.notEqual(player.mixStream, mixerAfterFirstPlay)
  assert.equal(player.mixStream.isDestroyed(), false)

  queue.add(createTrack({
    title: 'Track B',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    videoId: 'vid-b',
  }))
  await player.playNext()

  assert.equal(queue.current.title, 'Track B')
  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing)
  assert.equal(audioPlayer.resource.stream, player.mixStream)
  assert.deepEqual(started, ['vid-a', 'vid-b'])
  assert.ok(resources.length >= 2)

  await player.stop()
})

test('GuildPlayer: queue exhaustion with no handleQueueExhausted disconnects as before', async () => {
  let disconnected = false
  const onDisconnect = async () => { disconnected = true }
  const { player, audioPlayer } = makePlayer({ trackDuration: 3, onDisconnect })

  await player.playNext()
  triggerTrackEnd({ mixStream: player.mixStream })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disconnected, true)
})

test('GuildPlayer: a flowing mixer pipeline still plays PCM after createAudioResource attaches', async () => {
  // @discordjs/voice createAudioResource(StreamType.Raw) pipelines MixStream
  // into an opus encoder immediately. That used to start the underrun
  // watchdog and/or pause MixStream before playNext setCurrent, so Discord
  // sent packets (speaking) while the track never became audible.
  const { PassThrough } = await import('node:stream')
  const { FRAME_BYTES } = await import('../audio/fade.js')
  const { PcmSource } = await import('../audio/pcmSource.js')

  const tone = Buffer.alloc(FRAME_BYTES)
  new Int16Array(tone.buffer, tone.byteOffset, FRAME_BYTES / 2).fill(4321)
  const received = []

  const { player } = makePlayer({
    framesPerTrack: 8,
    createPcmSourceFn: async () => PcmSource.fromBuffers([Buffer.from(tone), Buffer.from(tone)]),
    audioPlayer: makeAudioPlayer(),
  })

  const mix = player.mixStream
  const sink = new PassThrough()
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)))
  mix.pipe(sink)
  try {
    await new Promise((resolve) => setImmediate(resolve))

    await player.playNext()

    const containsTone = () => {
      for (const chunk of received) {
        const view = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
        for (let i = 0; i < view.length; i++) {
          if (view[i] === 4321) return true
        }
      }
      return false
    }

    const deadline = Date.now() + 1000
    while (!containsTone() && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    assert.ok(containsTone(), 'expected real PCM after leading silence')
  } finally {
    mix.unpipe(sink)
    await player.stop()
  }
})

test('GuildPlayer: seekTo rebuilds the source at the offset and adopts it in place', async () => {
  const calls = []
  const { player } = makePlayer({
    trackDuration: 60,
    createPcmSourceFn: async (track, opts) => {
      calls.push(opts)
      const source = makePendingPcmSource()
      deliverPcm(source)
      return source
    },
  })

  assert.equal(await player.seekTo(10), false, 'seek with nothing playing must fail')

  await player.playNext()
  const firstSource = player.mixStream.currentSource

  assert.equal(await player.seekTo(30), 30)
  assert.equal(calls.at(-1).startSec, 30)
  assert.notEqual(player.mixStream.currentSource, firstSource, 'seek must swap the current source')
  assert.ok(player.trackPositionSec >= 30 && player.trackPositionSec < 31,
    `trackPositionSec should be ~30, got ${player.trackPositionSec}`)

  // Absolute seeks clamp inside the resolved duration (60s track) and
  // report the applied position so callers can display what happened.
  assert.equal(await player.seekTo(90), 59.5)
  assert.equal(calls.at(-1).startSec, 59.5)

  await player.stop()
})

test('GuildPlayer: seekTo keeps the same queue slot — no trackend, no advance', async () => {
  const { player, queue } = makePlayer({
    trackDuration: 60,
    createPcmSourceFn: async () => {
      const source = makePendingPcmSource()
      deliverPcm(source)
      return source
    },
  })
  queue.add(createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b', duration: 60 }))

  await player.playNext()
  assert.equal(queue.current?.title, 'Track A')
  assert.equal(await player.seekTo(20), 20)
  assert.equal(queue.current?.title, 'Track A', 'seek must not advance the queue')
  assert.equal(queue.upcoming().length, 1)

  await player.stop()
})

test('GuildPlayer: seekTo reuses the current normalized file instead of re-fetching', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { GuildPlayer } = await import('./player.js')
  const { GuildQueue } = await import('./queue.js')
  const dir = mkdtempSync('/tmp/seek-reuse-')
  const wav = `${dir}/src.wav`
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-ar', '48000', '-ac', '2', wav], { stdio: 'pipe' })

  // Build without createPcmSourceFn: the real #createPcmSource path must run
  // so the prefetched file is tracked as #currentTempFile.
  const queue = new GuildQueue()
  queue.add(createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a', duration: 60 }))
  let fetches = 0
  const player = new GuildPlayer({
    guildId: 'guild-1',
    queue,
    audioPlayer: makeAudioPlayer(),
    connection: { subscribe() {} },
    onDisconnect: async () => {},
    prefetchTrackFn: async () => {
      fetches += 1
      return {
        filePath: wav,
        measured: { measured_I: -30, measured_TP: 0, measured_LRA: 0, measured_thresh: -40, offset: 0 },
      }
    },
    getTrackAnalysisFn: async () => null,
    analyzeTrackFileFn: async () => null,
    resolveAudioStreamFn: (url) => ({ url }),
    createAudioResourceFn: (stream) => ({ stream, playStream: { destroy() {} } }),
  })

  await player.playNext()
  const firstSource = player.mixStream.currentSource
  assert.ok(firstSource, 'expected a live source')
  assert.equal(fetches, 1, 'sanity: initial fetch happened once')

  assert.equal(await player.seekTo(30), 30)
  assert.equal(fetches, 1, 'seek must not re-download the track')
  assert.notEqual(player.mixStream.currentSource, firstSource, 'seek must swap the source')
  assert.ok(player.trackPositionSec >= 30 && player.trackPositionSec < 31,
    `trackPositionSec should be ~30, got ${player.trackPositionSec}`)

  await player.stop()
})

// --- QueueAdvancement stopGeneration guards --------------------------------
// The drain is exercised directly so each await boundary can be held open
// with a deferred promise — no sleeps. stopState stands in for the player's
// #stopping/#stopGeneration pair: a stop bumps generation synchronously at
// entry, so a stop that BEGINS and even COMPLETES inside a drain await is
// still visible to the drain as a generation delta.

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function makeAdvancementDeps({ queue, stopState = {}, handleQueueExhausted = null } = {}) {
  const calls = { playNext: [], disconnect: 0, prefetchUpcoming: 0 }
  const flags = { forceSkip: false, hadError: false }
  const deps = {
    queue,
    handleQueueExhausted,
    queueExhaustedTimeoutMs: 5_000,
    transitions: {
      clearCrossfadeArm() {},
      stemMixUnavailableKey: null,
      pendingGaplessFrom: null,
    },
    sourcePreparer: {
      preparedIncoming: null,
      clearPreparedIncoming() {},
      async cleanupIncomingTempFile() {},
      prefetchUpcoming() { calls.prefetchUpcoming += 1 },
    },
    playNext: async (gaplessFrom = null) => { calls.playNext.push(gaplessFrom) },
    disconnect: async () => { calls.disconnect += 1 },
    cleanupCurrentTempFile: async () => {},
    clearWatchdog: () => {},
    isStopping: () => stopState.stopping === true,
    stopGeneration: () => stopState.generation ?? 0,
    isForceSkip: () => flags.forceSkip,
    clearForceSkip: () => { flags.forceSkip = false },
    isHadError: () => flags.hadError,
    clearHadError: () => { flags.hadError = false },
    // Past the reconnect grace so the natural-end path runs by default.
    getPlaybackStart: () => Date.now() - 60_000,
  }
  return { deps, calls, flags, stopState }
}

function countQueueNexts(queue) {
  const origNext = queue.next.bind(queue)
  let nextCalls = 0
  queue.next = (opts) => { nextCalls += 1; return origNext(opts) }
  return () => nextCalls
}

test('QueueAdvancement: a drain held in cleanup when stop() begins does not queue.next', async () => {
  const trackA = createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a' })
  const trackB = createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b' })
  const queue = new GuildQueue()
  queue.add(trackA)
  queue.add(trackB)
  const nextCalls = countQueueNexts(queue)
  const cleanup = deferred()
  const { deps, calls, stopState } = makeAdvancementDeps({ queue })
  deps.cleanupCurrentTempFile = () => cleanup.promise
  const adv = new QueueAdvancement(deps)

  adv.advanceAfterPlayback()
  assert.equal(adv.handlingAfter, true)
  // stop() begins while the drain is parked on the cleanup await.
  stopState.generation = 1
  stopState.stopping = true
  cleanup.resolve()
  await nextTurn()

  assert.equal(nextCalls(), 0, 'stale drain must not advance the queue')
  assert.equal(queue.current, trackA)
  assert.deepEqual(calls.playNext, [])
  assert.equal(calls.disconnect, 0)
  assert.equal(adv.handlingAfter, false, 'aborted drain must release the drain lock')
})

test('QueueAdvancement: a drain held in cleanup when stop() begins does not disconnect', async () => {
  // Single track: an unguarded drain would reach queue.next() → null →
  // refill → disconnect once the cleanup await resolves.
  const queue = new GuildQueue()
  queue.add(createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a' }))
  const cleanup = deferred()
  let exhaustionCalls = 0
  const { deps, calls, stopState } = makeAdvancementDeps({
    queue,
    handleQueueExhausted: async () => { exhaustionCalls += 1; return false },
  })
  deps.cleanupCurrentTempFile = () => cleanup.promise
  const adv = new QueueAdvancement(deps)

  adv.advanceAfterPlayback()
  stopState.generation = 1
  stopState.stopping = true
  cleanup.resolve()
  await nextTurn()

  assert.equal(exhaustionCalls, 0)
  assert.equal(calls.disconnect, 0)
  assert.equal(adv.handlingAfter, false)
})

test('QueueAdvancement: a stop that began AND completed during an await still aborts the drain', async () => {
  const trackA = createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a' })
  const trackB = createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b' })
  const queue = new GuildQueue()
  queue.add(trackA)
  queue.add(trackB)
  const nextCalls = countQueueNexts(queue)
  const cleanup = deferred()
  const { deps, calls, stopState } = makeAdvancementDeps({ queue })
  deps.cleanupCurrentTempFile = () => cleanup.promise
  const adv = new QueueAdvancement(deps)

  adv.advanceAfterPlayback()
  // The whole stop lifecycle fits inside the cleanup await: isStopping is
  // false again by the time it resolves — only the generation delta marks
  // this drain as stale.
  stopState.generation = 1
  stopState.stopping = false
  cleanup.resolve()
  await nextTurn()

  assert.equal(nextCalls(), 0, 'a completed stop must not resume the stale drain')
  assert.equal(queue.current, trackA)
  assert.deepEqual(calls.playNext, [])
  assert.equal(calls.disconnect, 0)
  assert.equal(adv.handlingAfter, false)
})

test('QueueAdvancement: a refill resolving after stop() began does not disconnect', async () => {
  const queue = new GuildQueue()
  queue.add(createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a' }))
  const refill = deferred()
  const { deps, calls, stopState } = makeAdvancementDeps({
    queue,
    handleQueueExhausted: () => refill.promise,
  })
  const adv = new QueueAdvancement(deps)

  adv.advanceAfterPlayback()
  await nextTurn()
  assert.equal(queue.current, null, 'sanity: the natural end advanced past the last track')

  // stop() begins while the drain is parked on the refill; a stale
  // handled=false must not run disconnect on top of the stop's teardown.
  stopState.generation = 1
  stopState.stopping = true
  refill.resolve(false)
  await nextTurn()

  assert.equal(calls.disconnect, 0)
  assert.equal(adv.handlingAfter, false)
})

test('QueueAdvancement: normal track end still advances to the next track', async () => {
  const trackA = createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a' })
  const trackB = createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b' })
  const queue = new GuildQueue()
  queue.add(trackA)
  queue.add(trackB)
  const { deps, calls } = makeAdvancementDeps({ queue })
  const adv = new QueueAdvancement(deps)

  adv.advanceAfterPlayback()
  await nextTurn()

  assert.equal(queue.current, trackB)
  assert.deepEqual(calls.playNext, [trackA], 'natural end hands the finished track to playNext as gaplessFrom')
  assert.equal(adv.handlingAfter, false)
})

test('QueueAdvancement: force skip still advances to the next track', async () => {
  const trackA = createTrack({ title: 'Track A', webpageUrl: 'https://example.com/a' })
  const trackB = createTrack({ title: 'Track B', webpageUrl: 'https://example.com/b' })
  const queue = new GuildQueue()
  queue.add(trackA)
  queue.add(trackB)
  const { deps, calls, flags } = makeAdvancementDeps({ queue })
  flags.forceSkip = true
  const adv = new QueueAdvancement(deps)

  adv.advanceAfterPlayback()
  await nextTurn()

  assert.equal(queue.current, trackB)
  assert.equal(flags.forceSkip, false, 'drain consumes the force-skip flag')
  assert.equal(calls.playNext.length, 1)
  assert.equal(adv.handlingAfter, false)
})

test('GuildPlayer: a trackend drain overtaken by stop() does not refill or disconnect', async () => {
  let exhaustionCalls = 0
  let disconnected = false
  const { player } = makePlayer({
    handleQueueExhausted: async () => { exhaustionCalls += 1; return false },
    onDisconnect: async () => { disconnected = true },
  })

  await player.playNext()
  triggerTrackEnd({ mixStream: player.mixStream })
  // The drain's first await is already pending; a synchronous stop() lands
  // inside it (generation bumps before teardown microtasks run).
  await player.stop()
  await nextTurn()

  assert.equal(exhaustionCalls, 0, 'stale drain must not kick the refill path')
  assert.equal(disconnected, false, 'stale drain must not disconnect')
})
