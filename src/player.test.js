import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPlayerStatus, StreamType } from '@discordjs/voice'
import { createTrack } from './queue.js'
import { triggerTrackEnd } from './player/playbackDrive.js'
import { makePlayer, makeAudioPlayer, nextTurn } from './player/test-helpers.js'
import { ANALYSIS_VERSION } from './audio/trackAnalysis.js'

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
  assert.deepEqual(resources[0].options, {
    inputType: StreamType.Raw,
  })

  await player.stop()
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
  const { FRAME_BYTES } = await import('./audio/fade.js')
  const { PcmSource } = await import('./audio/pcmSource.js')

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
