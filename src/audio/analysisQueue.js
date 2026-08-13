import { spawn } from 'node:child_process';

export const ANALYSIS_NICE = 15;
export const UNDERRUN_PAUSE_MS = 150;
export const MAX_PAUSES = 3;
export const MAX_STOPPED_MS = 2000;

const THREAD_ENV = {
  OMP_NUM_THREADS: '1',
  MKL_NUM_THREADS: '1',
};

let defaultQueue = null;

/**
 * Process-wide serial queue for MIX analysis (Demucs / aubio / ffmpeg).
 * MixStream underruns pause the current child via SIGSTOP so the mixer
 * keeps 20ms frames; the job is killed if pauses keep happening.
 */
export function createAnalysisQueue({
  spawnFn = spawn,
  niceLevel = ANALYSIS_NICE,
  pauseAfterUnderrunMs = UNDERRUN_PAUSE_MS,
  maxPauses = MAX_PAUSES,
  maxStoppedMs = MAX_STOPPED_MS,
  clock = () => Date.now(),
  useNice = true,
} = {}) {
  const jobs = [];
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  let running = false;
  let currentReject = null;
  let currentAbort = null;
  let paused = false;
  let pauseCount = 0;
  let stoppedAt = 0;
  let underrunSince = null;

  function childPids() {
    return [...children].filter((proc) => proc.pid && !proc.killed);
  }

  function signalChildren(sig) {
    for (const proc of childPids()) {
      try {
        process.kill(proc.pid, sig);
      } catch {
        // already gone
      }
    }
  }

  function killCurrent(reason) {
    for (const proc of childPids()) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    children.clear();
    paused = false;
    stoppedAt = 0;
    const reject = currentReject;
    const abort = currentAbort;
    currentReject = null;
    currentAbort = null;
    if (abort) abort();
    if (reject) {
      const err = reason instanceof Error ? reason : new Error(String(reason ?? 'analysis killed'));
      err.code = 'ANALYSIS_KILLED';
      reject(err);
    }
  }

  function register(proc) {
    if (!proc) return proc;
    children.add(proc);
    const cleanup = () => children.delete(proc);
    proc.once('close', cleanup);
    proc.once('exit', cleanup);
    proc.once('error', cleanup);
    if (paused && proc.pid) {
      try {
        process.kill(proc.pid, 'SIGSTOP');
      } catch {
        // ignore
      }
    }
    return proc;
  }

  function spawnNice(command, args = [], options = {}) {
    const env = {
      ...process.env,
      ...THREAD_ENV,
      TORCH_HOME: process.env.TORCH_HOME || '/opt/torch-cache',
      ...options.env,
    };
    const spawnOpts = { ...options, env };
    let proc;
    if (useNice) {
      proc = spawnFn('nice', ['-n', String(niceLevel), command, ...args], spawnOpts);
    } else {
      proc = spawnFn(command, args, spawnOpts);
    }
    return register(proc);
  }

  async function pump() {
    if (running) return;
    const job = jobs.shift();
    if (!job) return;
    running = true;
    pauseCount = 0;
    paused = false;
    stoppedAt = 0;
    underrunSince = null;
    currentReject = job.reject;
    let abortFn = null;
    const aborted = new Promise((_, reject) => {
      abortFn = () => {
        const err = new Error('analysis killed');
        err.code = 'ANALYSIS_KILLED';
        reject(err);
      };
    });
    currentAbort = abortFn;
    try {
      const result = await Promise.race([
        job.fn({ spawnNice, register }),
        aborted,
      ]);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      currentReject = null;
      currentAbort = null;
      running = false;
      children.clear();
      paused = false;
      queueMicrotask(pump);
    }
  }

  return {
    get pending() {
      return jobs.length;
    },
    get isRunning() {
      return running;
    },
    get isPaused() {
      return paused;
    },
    get pauseCount() {
      return pauseCount;
    },
    spawn: spawnNice,
    register,
    enqueue(fn) {
      return new Promise((resolve, reject) => {
        jobs.push({ fn, resolve, reject });
        pump();
      });
    },
    noteUnderrun() {
      if (!running) return;
      const now = clock();
      if (underrunSince == null) underrunSince = now;
      if (now - underrunSince < pauseAfterUnderrunMs) return;

      if (paused) {
        if (stoppedAt && now - stoppedAt >= maxStoppedMs) {
          killCurrent(new Error('analysis stopped too long during underrun'));
        }
        return;
      }

      pauseCount += 1;
      if (pauseCount > maxPauses) {
        killCurrent(new Error('analysis paused too many times during underrun'));
        return;
      }
      paused = true;
      stoppedAt = now;
      signalChildren('SIGSTOP');
    },
    noteUnderrunCleared() {
      underrunSince = null;
      if (!paused) return;
      paused = false;
      stoppedAt = 0;
      signalChildren('SIGCONT');
    },
    kill(reason) {
      killCurrent(reason);
    },
  };
}

export function getAnalysisQueue() {
  if (!defaultQueue) {
    defaultQueue = createAnalysisQueue();
  }
  return defaultQueue;
}

/** Test-only: replace or clear the process-wide queue. */
export function setAnalysisQueueForTest(queue) {
  defaultQueue = queue;
}
