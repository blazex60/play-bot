import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { BYTES_PER_SECOND } from './fade.js';

export const ANALYSIS_VERSION = 1;

function spawnCapture(cmd, args, { timeoutMs = 120_000 } = {}) {
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

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function analyzeTailShape(filePath, durationSec) {
  const tail = Math.min(30, Math.max(5, durationSec * 0.25));
  const start = Math.max(0, durationSec - tail);
  const { stderr, code } = await spawnCapture('ffmpeg', [
    '-hide_banner', '-nostats',
    '-ss', String(start),
    '-i', filePath,
    '-af',
    'silencedetect=noise=-40dB:d=0.3,astats=metadata=1:reset=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ]);
  const levels = [...stderr.matchAll(/RMS_level=([-0-9.]+)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const silenceStarts = [...stderr.matchAll(/silence_start:\s*([-0-9.]+)/g)].map((m) => Number(m[1]));

  let shape = 'unknown';
  if (levels.length >= 5) {
    const head = average(levels.slice(0, Math.floor(levels.length * 0.3)));
    const end = average(levels.slice(-Math.floor(levels.length * 0.2)));
    const drop = head - end;
    if (end < -45 || silenceStarts.length > 0) shape = 'silence-tail';
    else if (drop > 12) shape = 'fade-out';
    else if (Math.abs(drop) < 4) shape = 'abrupt';
    else shape = 'gentle-decay';
  }

  return {
    ok: code === 0 && levels.length > 0,
    shape,
    lastRms: levels.at(-1) ?? null,
    silenceCount: silenceStarts.length,
  };
}

async function analyzeBpm(filePath) {
  const which = await spawnCapture('bash', ['-lc', 'command -v aubiotrack || true']);
  if (!which.stdout.trim()) {
    return { available: false, bpm: null, confidence: 0 };
  }
  const wavPath = `${filePath}.analysis.wav`;
  try {
    const conv = await spawnCapture('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-t', '60', '-i', filePath,
      '-ac', '1', '-ar', '44100', wavPath,
    ]);
    if (conv.code !== 0) {
      return { available: true, ok: false, bpm: null, beatCount: 0, confidence: 0 };
    }
    const { stdout, code } = await spawnCapture('aubiotrack', ['-i', wavPath]);
    const beats = stdout.trim().split('\n').map(Number).filter((n) => Number.isFinite(n));
    let bpm = null;
    if (beats.length >= 4) {
      const intervals = [];
      for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
      intervals.sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      if (median > 0) bpm = Number((60 / median).toFixed(2));
    }
    return {
      available: true,
      ok: code === 0 && bpm != null,
      bpm,
      beatCount: beats.length,
      // Without Percival cross-check in this path, treat as medium confidence.
      confidence: bpm != null ? 0.6 : 0,
    };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

/**
 * Recommend overlap seconds from tail shape. Vocal-safe clamp applied in transition.js.
 */
export function recommendOverlapSec(shape, durationSec) {
  let sec;
  switch (shape) {
    case 'fade-out':
      sec = 1.5;
      break;
    case 'gentle-decay':
      sec = 2.5;
      break;
    case 'silence-tail':
      sec = 3;
      break;
    case 'abrupt':
      sec = 5;
      break;
    default:
      sec = 2;
  }
  const cap = Math.max(1, durationSec * 0.1);
  return Math.min(sec, cap);
}

/**
 * Analyze a downloaded audio file for MIX transitions.
 * Key detection (essentia) is optional and currently left null with low harmonic confidence.
 */
export async function analyzeTrackFile(filePath, { videoId = null, durationSec = null } = {}) {
  let duration = durationSec;
  if (duration == null || !Number.isFinite(duration)) {
    const { stdout } = await spawnCapture('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    duration = Number(stdout.trim());
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('unable to determine track duration for analysis');
  }

  const [tail, bpm] = await Promise.all([
    analyzeTailShape(filePath, duration),
    analyzeBpm(filePath).catch(() => ({ available: false, bpm: null, confidence: 0 })),
  ]);

  const overlapSec = recommendOverlapSec(tail.shape, duration);
  // Phase 1.5: center-only vocal detection rejected. Until PitchMelodia lands,
  // keep vocalConfidence low so transition clamps overlap aggressively.
  const vocalConfidence = 0.2;
  const harmonicConfidence = 0;
  const bpmConfidence = bpm.confidence ?? 0;

  const confidence = Math.min(
    tail.ok ? 0.8 : 0.3,
    0.4 + bpmConfidence * 0.3,
    0.35 + vocalConfidence,
  );

  return {
    version: ANALYSIS_VERSION,
    videoId,
    durationSec: duration,
    tailShape: tail.shape,
    lastRms: tail.lastRms,
    bpm: bpm.bpm,
    bpmConfidence,
    headKey: null,
    tailKey: null,
    harmonicConfidence,
    vocalConfidence,
    recommendedOverlapSec: overlapSec,
    confidence,
    // Unix seconds — matches track_analysis.analyzed_at / nowUnix().
    analyzedAt: Math.floor(Date.now() / 1000),
  };
}

export function bytesForSeconds(sec) {
  return Math.round(sec * BYTES_PER_SECOND);
}
