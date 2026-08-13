import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPlayerStatus, StreamType } from '@discordjs/voice'
import { createTrack } from './queue.js'
import { triggerTrackEnd } from './player/playbackDrive.js'
import { makePlayer } from './player/test-helpers.js'

test('GuildPlayer.status reflects the audio player state', () => {
  const { player, audioPlayer } = makePlayer()

  assert.equal(player.status, AudioPlayerStatus.Idle)
  audioPlayer.state = { status: AudioPlayerStatus.Playing }
  assert.equal(player.status, AudioPlayerStatus.Playing)
})

test('GuildPlayer.playNext creates a resource and tracks it as the current resource', async () => {
  const { player, audioPlayer, resources } = makePlayer()

  await player.playNext()

  assert.equal(audioPlayer.resource, resources[0])
  assert.deepEqual(resources[0].options, {
    inputType: StreamType.Arbitrary,
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
  triggerTrackEnd({ audioPlayer })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disconnected, true)
})
