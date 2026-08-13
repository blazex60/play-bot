import { spawn } from 'node:child_process';
import { unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HEAD_KEY_SEC = 30;
const TAIL_KEY_SEC = 30;

function spawnCapture(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function extractFloatMono(filePath, { startSec, durationSec }) {
  const outPath = path.join(
    tmpdir(),
    `musicbot-key-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.f32`,
  );
  try {
    const conv = await spawnCapture('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(Math.max(0, startSec)),
      '-t', String(durationSec),
      '-i', filePath,
      '-ac', '1',
      '-ar', '44100',
      '-f', 'f32le',
      outPath,
    ]);
    if (conv.code !== 0) return null;
    const buf = await readFile(outPath);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

function formatKey(key, scale) {
  if (!key) return null;
  const pitch = String(key).trim();
  const mode = String(scale ?? '').toLowerCase().startsWith('min') ? 'minor' : 'major';
  return `${pitch} ${mode}`;
}

/**
 * Best-effort head/tail key via essentia.js KeyExtractor.
 * Returns nulls when the WASM module is missing or extraction fails.
 */
export async function analyzeKeys(filePath, durationSec) {
  const empty = { headKey: null, tailKey: null, harmonicConfidence: 0 };
  if (!filePath || !(durationSec > 0)) return empty;

  let Essentia;
  let EssentiaWASM;
  try {
    const mod = await import('essentia.js');
    Essentia = mod.Essentia;
    EssentiaWASM = mod.EssentiaWASM;
    if (!Essentia || !EssentiaWASM) return empty;
  } catch {
    return empty;
  }

  try {
    const essentia = new Essentia(EssentiaWASM);
    const headDur = Math.min(HEAD_KEY_SEC, durationSec);
    const tailDur = Math.min(TAIL_KEY_SEC, durationSec);
    const tailStart = Math.max(0, durationSec - tailDur);

    const [headSamples, tailSamples] = await Promise.all([
      extractFloatMono(filePath, { startSec: 0, durationSec: headDur }),
      extractFloatMono(filePath, { startSec: tailStart, durationSec: tailDur }),
    ]);

    const extract = (samples) => {
      if (!samples || samples.length < 44100) return { key: null, strength: 0 };
      try {
        const vec = essentia.arrayToVector(samples);
        const result = essentia.KeyExtractor(vec);
        return {
          key: formatKey(result.key, result.scale),
          strength: Number(result.strength) || 0,
        };
      } catch {
        return { key: null, strength: 0 };
      }
    };

    const head = extract(headSamples);
    const tail = extract(tailSamples);
    const harmonicConfidence = Math.min(head.strength || 0, tail.strength || 0);
    return {
      headKey: head.key,
      tailKey: tail.key,
      harmonicConfidence,
    };
  } catch {
    return empty;
  }
}
