import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { CHANNELS, SAMPLE_RATE } from '../audio/fade.js';

/**
 * Opus packet → s16le PCM decoder. Prefers the native @discordjs/opus addon
 * (what the AudioPlayer's encoder uses); falls back to pure-JS opusscript
 * when the native binding is unavailable. Both are direct dependencies.
 */
export async function createOpusDecoder() {
  try {
    const mod = await import('@discordjs/opus');
    // CJS module: named exports are not statically analyzable, so they
    // surface under `default` rather than as named ESM exports.
    const OpusEncoder = mod.OpusEncoder ?? mod.default?.OpusEncoder;
    const encoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    encoder.decode(Buffer.from([248, 255, 254])); // probe: silence frame
    return (packet) => encoder.decode(packet);
  } catch {
    const { default: OpusScript } = await import('opusscript');
    const decoder = new OpusScript(SAMPLE_RATE, CHANNELS);
    return (packet) => Buffer.from(decoder.decode(packet));
  }
}

/**
 * A local stand-in for a Discord VoiceConnection: instead of encrypting opus
 * packets and sending them over UDP, it decodes each packet to s16le PCM and
 * writes it to a local audio sink (ffplay/aplay/wav).
 *
 * Implements the contract @discordjs/voice's AudioPlayer exercises on its
 * subscribed connections (see VoiceConnection in dist/index.js):
 *
 *   - `state.status === 'ready'`          — required by player.playable
 *   - `subscribe(player)`                 — registers via player['subscribe']
 *   - `prepareAudioPacket(opusPacket)`    — called once per ~20ms prepare tick
 *   - `dispatchAudio()`                   — called once per ~20ms dispatch tick
 *   - `setSpeaking(enabled)`              — speaking-state signal (no-op)
 *   - `onSubscriptionRemoved(sub)`        — PlayerSubscription teardown
 *   - `destroy()`                         — marks Destroyed + emits stateChange
 *
 * GuildPlayer also attaches `.on('stateChange')` and re-calls `subscribe()`
 * on AutoPaused, both of which this covers via EventEmitter + the methods
 * above. `state.subscription` mirrors VoiceConnection's own bookkeeping so a
 * second subscribe() returns the existing subscription instead of stacking.
 */
export class LocalVoiceConnection extends EventEmitter {
  #sink;
  #decode;
  #preparedPacket = null;
  #packetsWritten = 0;

  constructor({ sink, decode }) {
    super();
    if (!sink) throw new Error('LocalVoiceConnection requires a sink');
    this.#sink = sink;
    this.#decode = decode;
    this.state = { status: VoiceConnectionStatus.Ready, subscription: undefined };
  }

  /** Mirrors VoiceConnection#subscribe — returns the PlayerSubscription. */
  subscribe(player) {
    if (this.state.status === VoiceConnectionStatus.Destroyed) return;
    const subscription = player['subscribe'](this);
    this.state = { ...this.state, subscription };
    return subscription;
  }

  prepareAudioPacket(buffer) {
    if (this.state.status !== VoiceConnectionStatus.Ready) return;
    this.#preparedPacket = buffer;
  }

  dispatchAudio() {
    if (this.state.status !== VoiceConnectionStatus.Ready) return;
    const packet = this.#preparedPacket;
    this.#preparedPacket = null;
    if (!packet) return;
    let pcm;
    try {
      pcm = this.#decode(packet);
    } catch (err) {
      console.warn('[LocalVoiceConnection] opus decode failed, dropping frame:', err.message);
      return;
    }
    this.#packetsWritten += 1;
    this.#sink.write(pcm);
  }

  /** Convenience for playOpusPacket parity with the real class. */
  playOpusPacket(buffer) {
    this.prepareAudioPacket(buffer);
    return this.dispatchAudio();
  }

  setSpeaking() {
    return false;
  }

  onSubscriptionRemoved(subscription) {
    if (this.state.subscription === subscription) {
      this.state = { ...this.state, subscription: undefined };
    }
  }

  get packetsWritten() {
    return this.#packetsWritten;
  }

  get ping() {
    return { ws: 0, udp: 0 };
  }

  disconnect() {
    this.destroy();
    return true;
  }

  destroy() {
    if (this.state.status === VoiceConnectionStatus.Destroyed) return;
    const oldState = this.state;
    try {
      this.state.subscription?.unsubscribe();
    } catch { /* subscription may already be gone */ }
    this.state = { ...this.state, status: VoiceConnectionStatus.Destroyed, subscription: undefined };
    this.#preparedPacket = null;
    this.emit('stateChange', oldState, this.state);
    this.emit(VoiceConnectionStatus.Destroyed, oldState, this.state);
  }
}
