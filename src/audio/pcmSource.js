import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { resolveAudioStream } from '../search.js';
import { FRAME_BYTES } from './fade.js';

const LOUDNORM_TARGET = 'I=-16:TP=-1.5:LRA=11';
const MAX_BUFFER_BYTES = FRAME_BYTES * 100;

export class PcmSource extends EventEmitter {
  #buffer = Buffer.alloc(0);
  #proc = null;
  #input = null;
  #destroyed = false;
  #ended = false;
  #lastDataAt = Date.now();
  #error = null;

  constructor() {
    super();
  }

  get available() {
    return this.#buffer.length;
  }

  get ended() {
    return this.#ended;
  }

  get lastDataAt() {
    return this.#lastDataAt;
  }

  get error() {
    return this.#error;
  }

  read(bytes) {
    if (this.#buffer.length === 0) {
      return null;
    }
    const size = Math.min(bytes, this.#buffer.length);
    const chunk = this.#buffer.subarray(0, size);
    this.#buffer = this.#buffer.subarray(size);
    return chunk;
  }

  #attachStdout(stdout) {
    stdout.on('data', (data) => {
      if (this.#destroyed) return;
      this.#lastDataAt = Date.now();
      this.#buffer = Buffer.concat([this.#buffer, data]);
      if (this.#buffer.length > MAX_BUFFER_BYTES) {
        stdout.pause();
      }
      this.emit('data');
    });

    stdout.on('end', () => {
      if (this.#destroyed) return;
      this.#ended = true;
      this.emit('data');
      this.emit('end');
    });

    stdout.on('error', (err) => {
      this.#fail(err);
    });
  }

  #resumeIfPaused() {
    const stdout = this.#proc?.stdout;
    if (stdout?.isPaused?.()) {
      stdout.resume();
    }
  }

  #fail(err) {
    if (this.#destroyed) return;
    this.#error = err;
    this.#ended = true;
    // Avoid crashing the process when the consumer has not attached yet
    // (e.g. the gap between createStreamSource and MixStream.setCurrent).
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
    this.emit('end');
    this.destroy();
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#input?.destroy?.();
    this.#input?.kill?.();
    if (this.#proc && !this.#proc.killed) {
      this.#proc.kill('SIGKILL');
    }
    this.#buffer = Buffer.alloc(0);
    this.removeAllListeners();
  }

  _onFrameConsumed() {
    this.#resumeIfPaused();
  }

  static fromBuffers(chunks) {
    const source = new PcmSource();
    queueMicrotask(() => {
      for (const chunk of chunks) {
        source.#appendChunk(chunk);
      }
      source.#ended = true;
      source.emit('end');
    });
    return source;
  }

  #appendChunk(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#lastDataAt = Date.now();
    this.emit('data');
  }

  static createStreamSource(track, { resolveAudioStreamFn = resolveAudioStream } = {}) {
    const source = new PcmSource();
    const input = resolveAudioStreamFn(track.webpageUrl);
    source.#input = input;

    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 's16le',
      '-ar', String(48000),
      '-ac', '2',
      'pipe:1',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    source.#proc = proc;
    input.pipe(proc.stdin);
    input.on('error', (err) => source.#fail(err));
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => source.#fail(err));
    // Drain stderr so a noisy decode cannot fill the pipe and stall ffmpeg.
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    proc.stderr.on('error', () => {});
    proc.on('close', (code) => {
      if (code !== 0 && !source.ended && !source.#destroyed) {
        const detail = stderrTail.trim();
        source.#fail(new Error(
          detail ? `ffmpeg exited with ${code}: ${detail}` : `ffmpeg exited with ${code}`,
        ));
      }
    });

    source.#attachStdout(proc.stdout);
    return source;
  }

  static createFileSource(filePath, { measured }) {
    const source = new PcmSource();
    const filter = measured
      ? `loudnorm=${LOUDNORM_TARGET}:measured_I=${measured.measured_I}:measured_TP=${measured.measured_TP}:measured_LRA=${measured.measured_LRA}:measured_thresh=${measured.measured_thresh}:offset=${measured.offset}:linear=true`
      : 'anull';

    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-af', filter,
      '-f', 's16le',
      '-ar', String(48000),
      '-ac', '2',
      'pipe:1',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    source.#proc = proc;
    proc.on('error', (err) => source.#fail(err));
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d).slice(-2000);
    });
    proc.stderr.on('error', () => {});
    proc.on('close', (code) => {
      if (code !== 0 && !source.ended && !source.#destroyed) {
        const detail = stderrTail.trim();
        source.#fail(new Error(
          detail ? `ffmpeg exited with ${code}: ${detail}` : `ffmpeg exited with ${code}`,
        ));
      }
    });
    source.#attachStdout(proc.stdout);
    return source;
  }
}

export function createStreamSource(track, options) {
  return PcmSource.createStreamSource(track, options);
}

export function createFileSource(filePath, options) {
  return PcmSource.createFileSource(filePath, options);
}

