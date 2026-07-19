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

function makePlayer({ audioPlayer = makeAudioPlayer(), handleQueueExhausted, onDisconnect = async () => {}, trackDuration = 60 } = {}) {
  const queue = new GuildQueue()
  queue.add(createTrack({
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
      const volumeCalls = []
      const resource = {
        stream,
        options,
        volumeCalls,
        volume: {
          setVolume(level) {
            volumeCalls.push(level)
          },
        },
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

test('GuildPlayer.setVolume clamps and applies to current inline-volume resource', async () => {
  const { player, audioPlayer, resources } = makePlayer()

  assert.equal(player.setVolume(1.5), 1.5)
  await player.playNext()

  assert.equal(audioPlayer.resource, resources[0])
  assert.deepEqual(resources[0].options, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true,
  })
  assert.deepEqual(resources[0].volumeCalls, [1.5])

  assert.equal(player.setVolume(3), 2)
  assert.equal(player.setVolume(-1), 0)
  assert.deepEqual(resources[0].volumeCalls, [1.5, 2, 0])

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
