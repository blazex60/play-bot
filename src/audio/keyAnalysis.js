import { spawn } from 'node:child_process';
import { unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawnCapture } from './spawnCapture.js';

const HEAD_KEY_SEC = 30;
const TAIL_KEY_SEC = 30;
const KEY_WORKER_TIMEOUT_MS = 30_000;

async function extractFloatMono(filePath, { startSec, durationSec, spawnFn }) {
  const outPath = path.join(
    tmpdir(),
    `musicbot-key-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.f32`,
  );
  try {
    const conv = await spawnCapture(spawnFn, 'ffmpeg', [
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
    // Copy out of the Node Buffer pool so the worker transfer list cannot
    // detach MixStream's backing ArrayBuffer.
    const samples = new Float32Array(Math.floor(buf.byteLength / 4));
    samples.set(new Float32Array(buf.buffer, buf.byteOffset, samples.length));
    return samples;
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

function extractKeysInWorker(headSamples, tailSamples, { WorkerCtor = Worker } = {}) {
  return new Promise((resolve) => {
    const empty = { headKey: null, tailKey: null, harmonicConfidence: 0 };
    let worker;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate().catch(() => {});
      resolve(result ?? empty);
    };
    let timer;
    try {
      worker = new WorkerCtor(new URL('./keyAnalysisWorker.js', import.meta.url));
    } catch {
      resolve(empty);
      return;
    }
    timer = setTimeout(() => finish(empty), KEY_WORKER_TIMEOUT_MS);
    worker.once('message', finish);
    worker.once('error', () => finish(empty));
    const transfer = [];
    if (headSamples?.buffer) transfer.push(headSamples.buffer);
    if (tailSamples?.buffer) transfer.push(tailSamples.buffer);
    try {
      worker.postMessage({ head: headSamples, tail: tailSamples }, transfer);
    } catch {
      finish(empty);
    }
  });
}

/**
 * Best-effort head/tail key via essentia.js KeyExtractor in a worker thread
 * so WASM does not block MixStream's 20ms reads.
 */
export async function analyzeKeys(filePath, durationSec, { spawnFn = spawn, extractKeysFn = extractKeysInWorker } = {}) {
  const empty = { headKey: null, tailKey: null, harmonicConfidence: 0 };
  if (!filePath || !(durationSec > 0)) return empty;

  try {
    const headDur = Math.min(HEAD_KEY_SEC, durationSec);
    const tailDur = Math.min(TAIL_KEY_SEC, durationSec);
    const tailStart = Math.max(0, durationSec - tailDur);

    const [headSamples, tailSamples] = await Promise.all([
      extractFloatMono(filePath, { startSec: 0, durationSec: headDur, spawnFn }),
      extractFloatMono(filePath, { startSec: tailStart, durationSec: tailDur, spawnFn }),
    ]);

    return await extractKeysFn(headSamples, tailSamples);
  } catch {
    return empty;
  }
}

export { extractKeysInWorker };
