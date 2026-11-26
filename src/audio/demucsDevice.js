import { spawn } from 'node:child_process';
import path from 'node:path';
import { getLogger } from '../logging/appLogger.js';

const log = getLogger('demucsDevice');

/**
 * Which device Demucs runs on (GPU plan: .omc/plans/review-before-gpu.md).
 *
 * DEMUCS_DEVICE = auto (default) | cuda | cpu. `auto` asks the Demucs venv's
 * torch once whether CUDA works and caches the answer. A CUDA failure during
 * a real separation (driver update, passthrough lost, OOM) degrades the rest
 * of the process to CPU — the CPU path (windowed separation, CPU RTF) keeps
 * working, just slower.
 *
 * Measured on the production GTX 970 (2026-11-26, torch 2.7.1+cu126):
 * full 336 s track in 27 s, head+tail windows in 12 s, peak VRAM 860 MiB.
 */

let resolved = null;      // 'cuda' | 'cpu' once known
let probing = null;       // in-flight probe promise
let degraded = false;     // CUDA failed at runtime → stay on CPU

function pythonBin(env) {
  if (env.DEMUCS_PYTHON) return env.DEMUCS_PYTHON;
  return env.DEMUCS_VENV ? path.join(env.DEMUCS_VENV, 'bin', 'python') : 'python3';
}

export function requestedDemucsDevice(env = process.env) {
  const v = env.DEMUCS_DEVICE?.trim().toLowerCase();
  return v === 'cuda' || v === 'cpu' ? v : 'auto';
}

// Resolves true/false for a definite answer, null when the probe itself
// could not run (spawn error, timeout) — that is not cached, so a slow first
// import of torch does not pin the whole process to CPU.
function defaultProbe(env) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(pythonBin(env), ['-c', 'import torch; print(torch.cuda.is_available())'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(null); }, 60_000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && out.trim() === 'True'); });
  });
}

/**
 * @param {{ env?: object, probeFn?: (env: object) => Promise<boolean> }} [opts]
 * @returns {Promise<'cuda'|'cpu'>}
 */
export async function resolveDemucsDevice({ env = process.env, probeFn = defaultProbe } = {}) {
  if (degraded) return 'cpu';
  const requested = requestedDemucsDevice(env);
  if (requested === 'cpu') return 'cpu';
  if (requested === 'cuda') return 'cuda';
  if (resolved) return resolved;
  probing ??= probeFn(env).then((ok) => {
    if (ok == null) {
      log.warn({ event: 'audio.demucs.device_probe_failed' }, 'GPU の確認に失敗したため、今回は CPU を使う（次回また確認する）');
      return 'cpu';
    }
    resolved = ok ? 'cuda' : 'cpu';
    log.info({ event: 'audio.demucs.device', device: resolved }, `Demucs の実行デバイス: ${resolved}`);
    return resolved;
  }).finally(() => { probing = null; });
  return probing;
}

/** Last known device without probing — for synchronous estimates; 'cpu' until resolved. */
export function currentDemucsDevice(env = process.env) {
  if (degraded) return 'cpu';
  const requested = requestedDemucsDevice(env);
  if (requested !== 'auto') return requested;
  return resolved ?? 'cpu';
}

/** A CUDA run failed: use CPU for the rest of this process. */
export function markCudaFailed(err) {
  if (degraded) return;
  degraded = true;
  log.warn({ event: 'audio.demucs.cuda_failed', err }, 'CUDA での分離に失敗したため CPU に切り替え');
}

/** Heuristic: does this Demucs stderr look like a CUDA/GPU problem rather than a bad input? */
export function looksLikeCudaError(stderr = '') {
  return /cuda|cudnn|cublas|out of memory|no kernel image|nvidia|device-side/i.test(stderr);
}

export function resetDemucsDeviceForTest() {
  resolved = null;
  probing = null;
  degraded = false;
}
