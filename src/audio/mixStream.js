import { Readable } from 'node:stream';
import { FRAME_BYTES, BYTES_PER_SECOND } from './fade.js';
import { MAX_UNDERRUN_MS } from './config.js';

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

export class MixStream extends Readable {
  #current = null;
  #consumedBytes = 0;
  #underrunSince = null;
  #pendingRead = false;
  #destroyed = false;
  #betweenTracks = false;

  constructor() {
    super();
  }

  get positionSec() {
    return this.#consumedBytes / BYTES_PER_SECOND;
  }

  get currentSource() {
    return this.#current;
  }

  setCurrent(source) {
    if (this.#destroyed) {
      source.destroy();
      return;
    }

    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
    }

    // Source may have failed before any error listener was attached.
    // Surface it as sourceerror instead of installing a dead current.
    if (source.error) {
      source.destroy();
      this.#current = null;
      this.#betweenTracks = true;
      this.#underrunSince = null;
      this.emit('sourceerror', source.error);
      return;
    }

    this.#current = source;
    this.#consumedBytes = 0;
    this.#underrunSince = null;
    this.#betweenTracks = false;

    source.on('data', () => this.#scheduleRead());
    source.on('end', () => this.#scheduleRead());
    source.on('error', (err) => {
      this.emit('sourceerror', err);
      this.#finishCurrent();
    });

    this.#scheduleRead();
  }

  dropCurrent() {
    if (this.#current) {
      this.#current.removeAllListeners();
      this.#current.destroy();
      this.#current = null;
    }
    // Match #finishCurrent: stop silence/underrun while the next source loads.
    this.#betweenTracks = true;
    this.#underrunSince = null;
    this.emit('trackend');
  }

  endMixer() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#current?.destroy();
    this.#current = null;
    this.push(null);
  }

  _read() {
    this.#pendingRead = true;
    this.#tryPushFrame();
  }

  #scheduleRead() {
    if (this.#pendingRead) {
      this.#tryPushFrame();
    }
  }

  #tryPushFrame() {
    if (!this.#pendingRead || this.#destroyed) return;

    const frame = this.#readFrame();
    if (frame === null) {
      if (this.#betweenTracks) {
        this.#pendingRead = false;
        return;
      }
      if (!this.#underrunSince) {
        this.#underrunSince = Date.now();
      }
      if (Date.now() - this.#underrunSince >= MAX_UNDERRUN_MS) {
        this.emit('sourceerror', new Error(`underrun exceeded ${MAX_UNDERRUN_MS}ms`));
        this.#pendingRead = false;
        return;
      }
      this.push(SILENCE_FRAME);
      this.#pendingRead = false;
      this.emit('underrun');
      return;
    }

    this.#underrunSince = null;
    this.push(frame);
    this.#pendingRead = false;
    this.#current?._onFrameConsumed?.();
  }

  #readFrame() {
    if (!this.#current) {
      return null;
    }

    let frame = Buffer.alloc(0);
    while (frame.length < FRAME_BYTES) {
      const chunk = this.#current.read(FRAME_BYTES - frame.length);
      if (!chunk || chunk.length === 0) {
        if (this.#current.ended) {
          if (frame.length > 0) {
            return Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
          }
          this.#finishCurrent();
          return null;
        }
        return frame.length > 0 ? null : null;
      }
      frame = Buffer.concat([frame, chunk]);
    }

    this.#consumedBytes += FRAME_BYTES;
    return frame;
  }

  #finishCurrent() {
    const source = this.#current;
    this.#current = null;
    source?.removeAllListeners();
    source?.destroy();
    this.#betweenTracks = true;
    this.#underrunSince = null;
    this.emit('trackend');
  }
}

export { BYTES_PER_SECOND };
