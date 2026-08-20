import assert from 'node:assert/strict';
import { AudioPlayerStatus, StreamType } from '@discordjs/voice';
import { GuildPlayer } from '../player.js';
import { GuildQueue, createTrack } from '../queue.js';
import { PcmSource } from '../audio/pcmSource.js';
import { FRAME_BYTES } from '../audio/fade.js';

export function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

export function makeAudioPlayer() {
  return {
    state: { status: AudioPlayerStatus.Idle },
    events: new Map(),
    on(event, handler) {
      this.events.set(event, handler);
    },
    play(resource) {
      this.resource = resource;
      this.state = { status: AudioPlayerStatus.Playing, resource };
    },
    pause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Paused };
      return true;
    },
    unpause() {
      this.state = { ...this.state, status: AudioPlayerStatus.Playing };
      return true;
    },
    stop() {
      this.state = { status: AudioPlayerStatus.Idle };
    },
  };
}

export function makePlayer({
  audioPlayer = makeAudioPlayer(),
  handleQueueExhausted,
  onDisconnect = async () => {},
  trackDuration = 60,
  recordPlayFn,
  onTrackStart,
  track,
  createPcmSourceFn = null,
  getTrackAnalysisFn = null,
  analyzeTrackFileFn = null,
  prefetchTrackFn = async () => ({ filePath: '/tmp/musicbot-test-prefetch', measured: { measured_I: -16 } }),
  probeTempoBackendFn,
  framesPerTrack = 2,
  separateTrackStemsFn,
  getCachedStemsFn,
  planStemTransitionFn,
  createFileSourceFn,
} = {}) {
  const queue = new GuildQueue();
  queue.add(track ?? createTrack({
    title: 'Track A',
    webpageUrl: 'https://example.com/a',
    duration: trackDuration,
  }));

  const resources = [];
  const silentFrame = Buffer.alloc(FRAME_BYTES);
  const resolvedCreatePcmSourceFn = createPcmSourceFn ?? (async () => {
    return PcmSource.fromBuffers(Array.from({ length: framesPerTrack }, () => silentFrame));
  });

  const player = new GuildPlayer({
    guildId: 'guild-1',
    queue,
    audioPlayer,
    handleQueueExhausted,
    recordPlayFn,
    onTrackStart,
    createPcmSourceFn: resolvedCreatePcmSourceFn,
    getTrackAnalysisFn,
    analyzeTrackFileFn,
    prefetchTrackFn,
    probeTempoBackendFn,
    separateTrackStemsFn,
    getCachedStemsFn,
    planStemTransitionFn,
    createFileSourceFn,
    connection: {
      subscribe(subscribedPlayer) {
        assert.equal(subscribedPlayer, audioPlayer);
      },
    },
    onDisconnect,
    resolveAudioStreamFn(url) {
      return { url };
    },
    createAudioResourceFn(stream, options) {
      const resource = {
        stream,
        options,
        playStream: {
          destroy() {},
        },
      };
      resources.push(resource);
      return resource;
    },
  });

  return { player, audioPlayer, resources, queue };
}

export { StreamType };
