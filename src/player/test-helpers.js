import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AudioPlayerStatus, StreamType } from '@discordjs/voice';
import { GuildPlayer } from '../player.js';
import { GuildQueue, createTrack } from '../queue.js';
import { PcmSource } from '../audio/pcmSource.js';
import { FRAME_BYTES } from '../audio/fade.js';

export function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

export function makePendingPcmSource() {
  const source = new EventEmitter();
  source.ended = false;
  source.error = null;
  source.available = 0;
  source.read = () => null;
  source.destroy = () => {
    source.removeAllListeners();
    source.ended = true;
  };
  return source;
}

export function deliverPcm(source, bytes = FRAME_BYTES) {
  const frame = Buffer.alloc(bytes);
  source.available = bytes;
  source.read = (n) => {
    const chunk = frame.subarray(0, Math.min(n, frame.length));
    source.available = 0;
    source.read = () => null;
    return chunk;
  };
  source.emit('data');
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
      if (this.state.status !== AudioPlayerStatus.Playing) return false;
      this.state = { ...this.state, status: AudioPlayerStatus.Paused };
      return true;
    },
    unpause() {
      if (this.state.status !== AudioPlayerStatus.Paused) return false;
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
  stageTempFileCopyFn,
  separateTrackStemsFn,
  getCachedStemsFn,
  planStemTransitionFn,
  createFileSourceFn,
  logTransitionPlanFn,
  pcmWaitTimeoutMs,
  connection,
  analysisQueue,
  stemQueue,
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
    stageTempFileCopyFn,
    separateTrackStemsFn,
    getCachedStemsFn,
    planStemTransitionFn,
    createFileSourceFn,
    logTransitionPlanFn,
    pcmWaitTimeoutMs,
    analysisQueue,
    stemQueue,
    connection: connection ?? {
      subscribe(subscribedPlayer) {
        assert.equal(subscribedPlayer, audioPlayer);
      },
    },
    onDisconnect,
    resolveAudioStreamFn(url) {
      return { url };
    },
    createAudioResourceFn(stream, options) {
      assert.equal(options?.inputType, StreamType.Raw);
      assert.ok(
        stream?.currentSource,
        'createAudioResource must run after MixStream.setCurrent so the opus encoder is not starved',
      );
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

export { StreamType, FRAME_BYTES };
