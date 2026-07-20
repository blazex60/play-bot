import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPlayerStatus, StreamType } from '@discordjs/voice'
import { GuildPlayer } from './player.js'
import { GuildQueue, createTrack } from './queue.js'

function makeAudioPlayer() {
  return {
    state: { status: AudioPlayerStatus.Idle },
    events: new Map(),
    on(event, handler) {
      this.events.set(event, handler)
    },
    play(resource) {
      this.resource = resource
      this.state = { status: AudioPlayerStatus.Playing, resource }
    },
    pause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Paused }
      return true
    },
    unpause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Playing }
      return true
    },
    stop() {
      this.state = { status: AudioPlayerStatus.Idle }
    },
  }
}

function makePlayer({ audioPlayer = makeAudioPlayer(), handleQueueExhausted, onDisconnect = async () => {}, trackDuration = 60, recordPlayFn, track } = {}) {
  const queue = new GuildQueue()
  queue.add(track ?? createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: trackDuration,
  }))

  const resources = []
  const player = new GuildPlayer({
    guildId: 'guild-1',
    queue,
    audioPlayer,
    handleQueueExhausted,
    recordPlayFn,
    connection: {
      subscribe(subscribedPlayer) {
        assert.equal(subscribedPlayer, audioPlayer)
      },
    },
    onDisconnect,
    resolveAudioStreamFn(url) {
      return { url }
    },
    createAudioResourceFn(stream, options) {
      const resource = {
        stream,
        options,
        playStream: {
          destroy() {},
        },
      }
      resources.push(resource)
      return resource
    },
  })

  return { player, audioPlayer, resources, queue }
}

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

test('GuildPlayer: queue exhaustion with no handleQueueExhausted disconnects as before', async () => {
  let disconnected = false
  const onDisconnect = async () => { disconnected = true }
  const { player, audioPlayer } = makePlayer({ trackDuration: 3, onDisconnect })

  await player.playNext()
  const idleHandler = audioPlayer.events.get(AudioPlayerStatus.Idle)
  idleHandler()

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disconnected, true)
})

test('GuildPlayer: handleQueueExhausted returning true skips disconnect', async () => {
  let disconnected = false
  let handledCalled = false
  const onDisconnect = async () => { disconnected = true }
  const handleQueueExhausted = async (finishedTrack) => {
    handledCalled = true
    assert.equal(finishedTrack.title, 'Track A')
    return true
  }
  const { player, audioPlayer } = makePlayer({ trackDuration: 3, onDisconnect, handleQueueExhausted })

  await player.playNext()
  const idleHandler = audioPlayer.events.get(AudioPlayerStatus.Idle)
  idleHandler()

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(handledCalled, true)
  assert.equal(disconnected, false)
})

test('GuildPlayer: playNext records a play for tracks with a requester id', async () => {
  const calls = []
  const recordPlayFn = async (payload) => { calls.push(payload) }
  const track = createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    requestedBy: 'display-name',
    requestedById: 'discord-123',
    videoId: 'vid-1',
    channel: 'Channel A',
  })
  const { player } = makePlayer({ recordPlayFn, track })

  await player.playNext()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    guildId: 'guild-1',
    discordUserId: 'discord-123',
    username: 'display-name',
    trackTitle: 'Track A',
    trackUrl: 'https://example.com/a',
    videoId: 'vid-1',
    channel: 'Channel A',
  })

  await player.stop()
})

test('GuildPlayer: playNext does not record autoplay-selected tracks (no requester id)', async () => {
  const calls = []
  const recordPlayFn = async (payload) => { calls.push(payload) }
  const track = createTrack({
    title: 'Autoplay Track',
    webpageUrl: 'https://example.com/b',
    duration: 60,
    requestedBy: '🔀 自動再生',
    requestedById: null,
  })
  const { player } = makePlayer({ recordPlayFn, track })

  await player.playNext()

  assert.equal(calls.length, 0)

  await player.stop()
})

test('GuildPlayer: a rejecting recordPlayFn does not break playback', async () => {
  const recordPlayFn = async () => { throw new Error('web api down') }
  const track = createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: 60,
    requestedById: 'discord-123',
  })
  const { player, audioPlayer } = makePlayer({ recordPlayFn, track })

  await player.playNext()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(audioPlayer.state.status, AudioPlayerStatus.Playing)

  await player.stop()
})

test('GuildPlayer: handleQueueExhausted throwing falls back to disconnect safely', async () => {
  let disconnected = false
  const onDisconnect = async () => { disconnected = true }
  const handleQueueExhausted = async () => { throw new Error('boom') }
  const { player, audioPlayer } = makePlayer({ trackDuration: 3, onDisconnect, handleQueueExhausted })

  await player.playNext()
  const idleHandler = audioPlayer.events.get(AudioPlayerStatus.Idle)
  idleHandler()

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disconnected, true)
})
