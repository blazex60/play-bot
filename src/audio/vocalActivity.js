import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAnalysisQueue } from './analysisQueue.js';

/** Relative threshold: vocals are "present" when within this dB of the mix. */
export const VOCAL_RELATIVE_DB = 25;
/** Absolute floor — below this, treat as silence even if close to a quiet mix. */
export const VOCAL_ABS_DB = -50;
export const TAIL_WINDOW_SEC = 45;
export const VOCAL_FRAME_SEC = 0.1;
export const VOCAL_GAP_MIN_SEC = 1.5;
export const DEMUCS_MODEL = 'htdemucs';

export function parseRmsLevels(stderr) {
  return [...String(stderr ?? '').matchAll(/RMS_level=([-0-9.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

function isVocalFrame(vocalDb, mixDb) {
  if (!Number.isFinite(vocalDb)) return false;
  if (vocalDb <= VOCAL_ABS_DB) return false;
  if (Number.isFinite(mixDb) && vocalDb <= mixDb - VOCAL_RELATIVE_DB) return false;
  return true;
}

/**
 * Classify 100ms RMS envelopes from Demucs vocals vs the mix tail.
 * @param {{ vocalLevels: number[], mixLevels: number[], tailStartSec: number, frameSec?: number }} args
 */
export function classifyVocalEnvelope({
  vocalLevels,
  mixLevels,
  tailStartSec,
  frameSec = VOCAL_FRAME_SEC,
}) {
  const n = Math.max(vocalLevels.length, mixLevels.length);
  const flags = [];
  for (let i = 0; i < n; i += 1) {
    flags.push(isVocalFrame(vocalLevels[i], mixLevels[i]));
  }

  const vocalConfidence = n >= 5 ? 0.85 : n > 0 ? 0.5 : 0;
  if (flags.every((v) => !v)) {
    return {
      ok: true,
      lastVocalEndSec: tailStartSec,
      vocalGaps: n > 0
        ? [{ startSec: tailStartSec, endSec: tailStartSec + n * frameSec }]
        : [],
      vocalConfidence,
      source: 'demucs',
    };
  }

  let lastVocalIndex = -1;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) lastVocalIndex = i;
  }
  const lastVocalEndSec = tailStartSec + (lastVocalIndex + 1) * frameSec;

  const vocalGaps = [];
  let gapStart = null;
  for (let i = 0; i < flags.length; i += 1) {
    if (!flags[i]) {
      if (gapStart == null) gapStart = i;
    } else if (gapStart != null) {
      const startSec = tailStartSec + gapStart * frameSec;
      const endSec = tailStartSec + i * frameSec;
      if (endSec - startSec >= VOCAL_GAP_MIN_SEC) {
        vocalGaps.push({ startSec, endSec });
      }
      gapStart = null;
    }
  }
  if (gapStart != null) {
    const startSec = tailStartSec + gapStart * frameSec;
    const endSec = tailStartSec + flags.length * frameSec;
    if (endSec - startSec >= VOCAL_GAP_MIN_SEC) {
      vocalGaps.push({ startSec, endSec });
    }
  }

  return {
    ok: true,
    lastVocalEndSec,
    vocalGaps,
    vocalConfidence,
    source: 'demucs',
  };
}

function spawnCapture(spawnFn, cmd, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d; });
    proc.stderr?.on('data', (d) => { stderr += d; });
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

async function rmsEnvelope(spawnFn, filePath) {
  const { stderr, code } = await spawnCapture(spawnFn, 'ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', filePath,
    '-af', 'astats=metadata=1:reset=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  return {
    ok: code === 0,
    levels: parseRmsLevels(stderr),
  };
}

function resolveDemucsBin() {
  return process.env.DEMUCS_BIN
    || (process.env.DEMUCS_VENV ? path.join(process.env.DEMUCS_VENV, 'bin', 'demucs') : 'demucs');
}

/**
 * @param {string} filePath
 * @param {{ durationSec: number, tailWindowSec?: number, queue?: object, spawnFn?: Function }} [opts]
 */
export async function analyzeVocalActivity(filePath, {
  durationSec,
  tailWindowSec = TAIL_WINDOW_SEC,
  queue = null,
  spawnFn = null,
} = {}) {
  const empty = {
    ok: false,
    lastVocalEndSec: null,
    vocalGaps: [],
    vocalConfidence: 0,
    source: 'none',
  };
  if (!filePath || !(durationSec > 0)) return empty;

  const analysisQueue = queue ?? getAnalysisQueue();
  const run = spawnFn ?? ((cmd, args, options) => analysisQueue.spawn(cmd, args, options));

  const tailStart = Math.max(0, durationSec - tailWindowSec);
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'musicbot-vocal-'));
  const tailWav = path.join(tmpRoot, 'tail.wav');

  try {
    const cut = await spawnCapture(run, 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(tailStart),
      '-i', filePath,
      '-ac', '2',
      '-ar', '44100',
      tailWav,
    ]);
    if (cut.code !== 0) return empty;

    const demucsBin = resolveDemucsBin();
    const demucs = await spawnCapture(run, demucsBin, [
      '--two-stems=vocals',
      '-n', DEMUCS_MODEL,
      '-o', tmpRoot,
      tailWav,
    ], { timeoutMs: 300_000 });
    if (demucs.code !== 0) return empty;

    const vocalsWav = path.join(tmpRoot, DEMUCS_MODEL, 'tail', 'vocals.wav');
    const [vocalEnv, mixEnv] = await Promise.all([
      rmsEnvelope(run, vocalsWav),
      rmsEnvelope(run, tailWav),
    ]);
    if (!vocalEnv.ok || vocalEnv.levels.length === 0) return empty;

    return classifyVocalEnvelope({
      vocalLevels: vocalEnv.levels,
      mixLevels: mixEnv.levels,
      tailStartSec: tailStart,
    });
  } catch {
    return empty;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function defaultSpawn(cmd, args, options) {
  return spawn(cmd, args, options);
}
