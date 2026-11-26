import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { getLogger } from '../logging/appLogger.js';
import { currentDemucsDevice, resolveDemucsDevice } from './demucsDevice.js';

const log = getLogger('beatThis');

/**
 * Beat This! (CPJKU, MIT; .omc/plans/beat-this-integration.md) as the beat
 * and downbeat tracker. One long-lived Python worker in the Demucs venv keeps
 * the model loaded (~11 s to load, then 1-2 s per whole track on the GTX 970).
 *
 * BEAT_TRACKER = auto (default) | beat_this | aubio. `auto` uses Beat This!
 * only when Demucs resolved to CUDA; on CPU (or after the worker keeps
 * failing) analysis stays on aubio.
 */

export const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'beat_this_worker.py');
const READY_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
// Consecutive failures (startup or per-track) before giving up for the process.
const MAX_CONSECUTIVE_FAILURES = 3;

export function requestedBeatTracker(env = process.env) {
  const v = env.BEAT_TRACKER?.trim().toLowerCase();
  return v === 'beat_this' || v === 'aubio' ? v : 'auto';
}

function pythonBin(env) {
  if (env.DEMUCS_PYTHON) return env.DEMUCS_PYTHON;
  return env.DEMUCS_VENV ? path.join(env.DEMUCS_VENV, 'bin', 'python') : 'python3';
}

export class BeatThisWorker {
  #spawnFn;
  #env;
  #readyTimeoutMs;
  #requestTimeoutMs;
  #proc = null;
  #ready = null;        // Promise<void> while starting / once started
  #pending = new Map(); // id -> { resolve, reject, timer }
  #nextId = 1;
  #chain = Promise.resolve();
  #failures = 0;
  disabled = false;

  constructor({ spawnFn = spawn, env = process.env, readyTimeoutMs = READY_TIMEOUT_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.#spawnFn = spawnFn;
    this.#env = env;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  #start(device) {
    if (this.#ready) return this.#ready;
    const proc = this.#spawnFn('nice', ['-n', '10', pythonBin(this.#env), WORKER_SCRIPT, device], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#proc = proc;
    let stderrTail = '';
    proc.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-500); });
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Beat This! worker did not become ready'));
        this.#kill();
      }, this.#readyTimeoutMs);
      const lines = createInterface({ input: proc.stdout });
      lines.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if ('ready' in msg) {
          clearTimeout(timer);
          if (msg.ready) resolve();
          else reject(new Error(`Beat This! worker failed to start: ${msg.error ?? 'unknown'}`));
          return;
        }
        const entry = this.#pending.get(msg.id);
        if (!entry) return;
        this.#pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg);
        else entry.reject(new Error(msg.error ?? 'Beat This! failed'));
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); this.#reset(err); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        const err = new Error(`Beat This! worker exited with ${code}: ${stderrTail.trim().split('\n').slice(-2).join(' | ')}`);
        reject(err);
        this.#reset(err);
      });
    });
    return this.#ready;
  }

  #reset(err) {
    this.#proc = null;
    this.#ready = null;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.#pending.clear();
  }

  #kill() {
    try { this.#proc?.kill('SIGKILL'); } catch { /* already gone */ }
  }

  #fail(err) {
    this.#failures += 1;
    if (this.#failures >= MAX_CONSECUTIVE_FAILURES && !this.disabled) {
      this.disabled = true;
      log.warn({ event: 'audio.beat_this.disabled', err }, 'Beat This! が続けて失敗したため、拍の検出を aubio に戻す');
      this.#kill();
    }
  }

  /** Whole-track beats and downbeats (seconds). Requests run one at a time. */
  analyze(filePath, { device = 'cuda' } = {}) {
    const run = async () => {
      if (this.disabled) throw new Error('Beat This! is disabled');
      try {
        await this.#start(device);
        const id = this.#nextId++;
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`Beat This! timed out after ${this.#requestTimeoutMs}ms`));
            this.#kill(); // a wedged worker restarts on the next request
          }, this.#requestTimeoutMs);
          this.#pending.set(id, { resolve, reject, timer });
          this.#proc.stdin.write(`${JSON.stringify({ id, path: filePath })}\n`);
        });
        this.#failures = 0;
        return { beatsSec: result.beats, downbeatsSec: result.downbeats, inferMs: result.inferMs };
      } catch (err) {
        this.#fail(err);
        throw err;
      }
    };
    const job = this.#chain.then(run, run);
    this.#chain = job.catch(() => {});
    return job;
  }

  close() {
    this.disabled = true;
    this.#kill();
  }
}

let shared = null;
function sharedWorker() {
  shared ??= new BeatThisWorker();
  return shared;
}

/** Synchronous guess for cache-reuse decisions; never starts anything. */
export function isBeatThisAvailable(env = process.env, worker = shared) {
  const mode = requestedBeatTracker(env);
  if (mode === 'aubio' || worker?.disabled) return false;
  return mode === 'beat_this' || currentDemucsDevice(env) === 'cuda';
}

/**
 * Default `beatTrackerFn` for analyzeTrackFile: Beat This! output, or null
 * when it is not in use (aubio then provides the grid).
 */
export async function trackBeatsWithBeatThis(filePath, { env = process.env, worker = null, deviceFn = resolveDemucsDevice } = {}) {
  const mode = requestedBeatTracker(env);
  if (mode === 'aubio') return null;
  const w = worker ?? sharedWorker();
  if (w.disabled) return null;
  const device = await deviceFn({ env });
  if (mode === 'auto' && device !== 'cuda') return null;
  try {
    const result = await w.analyze(filePath, { device });
    return result;
  } catch (err) {
    log.warn({ event: 'audio.beat_this.failed', err }, 'Beat This! での拍の検出に失敗したため aubio を使う');
    return null;
  }
}

export function resetBeatThisForTest() {
  shared?.close();
  shared = null;
}
