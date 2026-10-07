import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { SAMPLE_RATE, CHANNELS, BYTES_PER_SAMPLE } from '../audio/fade.js';

/**
 * Local audio sinks for `bun run player`. Each sink consumes raw s16le PCM
 * (48 kHz stereo — the format MixStream outputs and the format opus packets
 * decode back to) and exposes { name, write(buf), close() }.
 *
 * - ffplay / aplay: spawn a local player process and stream PCM to its stdin.
 * - wav: write a .wav file (headless verification / machines without audio).
 */

function spawnSink(name, cmd, args) {
  const proc = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  let warnedBackpressure = false;
  let spawnError = null;
  proc.on('error', (err) => { spawnError = err; });
  return {
    name,
    get error() { return spawnError; },
    write(buf) {
      if (spawnError) return false;
      const ok = proc.stdin.write(buf);
      if (!ok && !warnedBackpressure) {
        warnedBackpressure = true;
        console.warn(`[sink:${name}] 出力が PCM 供給に追いついていません（バッファリング中）`);
      }
      return ok;
    },
    async close() {
      try { proc.stdin.end(); } catch { /* already closed */ }
      if (!proc.killed) proc.kill('SIGTERM');
    },
  };
}

export function createFfplaySink() {
  return spawnSink('ffplay', 'ffplay', [
    '-nodisp',
    '-autoexit',
    '-loglevel', 'warning',
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    '-',
  ]);
}

export function createAplaySink() {
  return spawnSink('aplay', 'aplay', [
    '-q',
    '-f', 'S16_LE',
    '-r', String(SAMPLE_RATE),
    '-c', String(CHANNELS),
  ]);
}

const WAV_HEADER_BYTES = 44;

function encodeWavHeader({ dataBytes = 0 } = {}) {
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function createWavSink(filePath) {
  const stream = createWriteStream(filePath);
  let dataBytes = 0;
  let headerWritten = false;
  return {
    name: `wav:${filePath}`,
    write(buf) {
      if (!headerWritten) {
        headerWritten = true;
        stream.write(encodeWavHeader());
      }
      dataBytes += buf.length;
      return stream.write(buf);
    },
    async close() {
      await new Promise((resolve, reject) => {
        stream.end(err => (err ? reject(err) : resolve()));
      });
      // Patch RIFF/data sizes with the real PCM byte count.
      const fd = await open(filePath, 'r+');
      try {
        await fd.write(encodeWavHeader({ dataBytes }), 0, WAV_HEADER_BYTES, 0);
      } finally {
        await fd.close();
      }
    },
  };
}

export const SINK_CHOICES = ['auto', 'ffplay', 'aplay', 'wav'];

/** Check a command exists on PATH (without spawning it for real). */
function commandExists(cmd) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-lc', `command -v ${cmd}`]);
    proc.on('error', () => resolve(false));
    proc.on('close', code => resolve(code === 0));
  });
}

/**
 * Resolve the requested sink. 'auto' prefers ffplay (shipped with FFmpeg,
 * which the bot already requires), then aplay.
 */
export async function createSink({ sink = 'auto', out = null } = {}) {
  if (sink === 'wav') {
    if (!out) throw new Error('--sink wav には --out <path> が必要です');
    return createWavSink(out);
  }
  if (sink === 'ffplay') return createFfplaySink();
  if (sink === 'aplay') return createAplaySink();
  if (sink !== 'auto') {
    throw new Error(`不明な sink: ${sink}（${SINK_CHOICES.join('|')} から選択）`);
  }
  if (await commandExists('ffplay')) return createFfplaySink();
  if (await commandExists('aplay')) return createAplaySink();
  throw new Error('ffplay / aplay が見つかりません。FFmpeg をインストールするか --sink wav --out <path> を指定してください');
}
