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
let defaultStemQueue = null;

/**
 * Process-wide serial queue for MIX analysis (Demucs / aubio / ffmpeg).
 * MixStream underruns pause the current child via SIGSTOP so the mixer
 * keeps 20ms frames; the job is killed if pauses keep happening.
 *
 * Phase 9C (docs/mix-transition-phase9.md §5): this factory is shared by
 * two independent singletons — getAnalysisQueue() (BPM/downbeat/phrase/key/
 * vocal-activity — kept fast/responsive) and getStemPreparationQueue()
 * (full-track Demucs only, concurrency 1 like today). Each call to this
 * factory returns its own fully independent closure over `jobs`/`children`/
 * `paused`/etc, so a long-running Demucs job enqueued on one instance can
 * never sit in front of — or share pause/kill state with — a job enqueued
 * on the other. Callers get two lanes by holding two separate instances,
 * not by this factory branching on a "kind" flag.
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
  let spawnEpoch = 0;
  let stopTimeoutHandle = null;
  const underrunSources = new Set();
  const ANON_UNDERRUN = Symbol('analysis-underrun');

  // Codex review (PR #45, round 4, P2): applyPause()'s own maxStoppedMs
  // check only runs when applyPause() is called AGAIN — noteUnderrun()'s
  // debounced path naturally re-invokes it as long as the mixer keeps
  // reporting the underrun, but the explicit pauseQueue() command (§5.4) is
  // edge-triggered: one call, then (normally) one matching resume. If the
  // resume never comes — the caller/monitor disappears, or a bug drops the
  // matching noteUnderrunCleared() — the paused job's SIGSTOP'd children
  // would otherwise stay stopped forever with nothing left to notice.
  // Arming a real timer here makes the kill-after-maxStoppedMs guarantee
  // hold regardless of whether anything ever calls applyPause() again.
  function armStopTimeout() {
    clearStopTimeout();
    stopTimeoutHandle = setTimeout(() => {
      stopTimeoutHandle = null;
      if (paused && stoppedAt) killCurrent(new Error('analysis stopped too long during underrun'));
    }, maxStoppedMs);
  }

  function clearStopTimeout() {
    if (stopTimeoutHandle != null) {
      clearTimeout(stopTimeoutHandle);
      stopTimeoutHandle = null;
    }
  }

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
    underrunSince = null;
    clearStopTimeout();
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
    const epoch = spawnEpoch;
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
    if (epoch !== spawnEpoch) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      return proc;
    }
    return register(proc);
  }

  async function pump() {
    if (running) return;
    const job = jobs.shift();
    if (!job) return;
    running = true;
    pauseCount = 0;
    // Codex review (PR #45, P2): don't blindly clear pause state on every
    // job start — pause()/noteUnderrun() can be called while idle (no job
    // running yet), and previously this unconditional reset threw that
    // pause away the instant a job started, letting a CPU-heavy job begin
    // fully unpaused during the exact pressure that was supposed to
    // suppress it. If underrunSources still holds a reason, this new job
    // starts already paused instead — register() below already SIGSTOPs a
    // freshly spawned child when `paused` is true at spawn time.
    if (underrunSources.size === 0) {
      paused = false;
      stoppedAt = 0;
      underrunSince = null;
      clearStopTimeout();
    } else if (!paused) {
      paused = true;
      stoppedAt = clock();
      armStopTimeout();
    }
    currentReject = job.reject;
    const abortController = new AbortController();
    let abortFn = null;
    const aborted = new Promise((_, reject) => {
      abortFn = () => {
        abortController.abort();
        const err = new Error('analysis killed');
        err.code = 'ANALYSIS_KILLED';
        reject(err);
      };
    });
    currentAbort = abortFn;
    const work = Promise.resolve().then(() => job.fn({
      spawnNice,
      register,
      signal: abortController.signal,
    }));
    try {
      const result = await Promise.race([work, aborted]);
      if (abortController.signal.aborted) {
        const err = new Error('analysis killed');
        err.code = 'ANALYSIS_KILLED';
        job.reject(err);
      } else {
        job.resolve(result);
      }
    } catch (err) {
      abortController.abort();
      job.reject(err);
    } finally {
      abortController.abort();
      currentReject = null;
      currentAbort = null;
      spawnEpoch += 1;
      for (const proc of childPids()) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
      children.clear();
      running = false;
      paused = false;
      queueMicrotask(pump);
    }
  }

  // Shared by the debounced noteUnderrun() pause path and the immediate
  // pause()/resume() commands below — both ultimately just SIGSTOP the
  // current job's children and arm the same maxStoppedMs kill timeout.
  function applyPause(now) {
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
    armStopTimeout();
  }

  function noteUnderrun(source = ANON_UNDERRUN) {
    if (!running) return;
    underrunSources.add(source);
    const now = clock();
    if (underrunSince == null) underrunSince = now;
    if (now - underrunSince < pauseAfterUnderrunMs) return;
    applyPause(now);
  }

  function noteUnderrunCleared(source = ANON_UNDERRUN) {
    underrunSources.delete(source);
    if (underrunSources.size > 0) return;
    underrunSince = null;
    if (!paused) return;
    paused = false;
    stoppedAt = 0;
    clearStopTimeout();
    signalChildren('SIGCONT');
  }

  // §5.4 "Playback Safety": an explicit pause/resume pair, distinct from
  // noteUnderrun()'s own debounced signal. Intended for a direct command
  // ("pause this queue now") rather than a raw, possibly-jittery underrun
  // signal — e.g. wiring the realtime queue's own underrun event to also
  // pause the stem-preparation queue (player.js), or any future
  // CPU-pressure monitor. Shares `underrunSources`/pause/kill state with
  // noteUnderrun()/noteUnderrunCleared() (both are just reasons this
  // queue's current job is held), so a source added via one is only ever
  // cleared via the matching call with the same source token, from either
  // API. No new automatic trigger is added here — callers decide when to
  // invoke it.
  function pauseQueue(source = ANON_UNDERRUN) {
    underrunSources.add(source);
    if (!running) return;
    const now = clock();
    if (underrunSince == null) underrunSince = now;
    applyPause(now);
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
    // Codex review (PR #45, P1): §5.3's HIGH(B)/LOW(C) priority previously
    // meant nothing beyond call order within this queue's plain FIFO — a
    // LOW job already sitting in `jobs` (or, worse, already RUNNING —
    // concurrency=1 means a HIGH request arriving mid-run must still wait
    // for it; true preemption of an in-flight Demucs job is a bigger change
    // than this fix, deliberately not attempted here, see
    // docs/mix-transition-phase9.md's Phase 9C notes) would still run
    // before a HIGH job requested afterward. `priority: 'high'` now
    // inserts ahead of every PENDING (not yet started) non-high job,
    // preserving relative order within each priority tier.
    enqueue(fn, { priority = 'normal' } = {}) {
      return new Promise((resolve, reject) => {
        const job = { fn, resolve, reject, priority };
        if (priority === 'high') {
          let insertAt = jobs.length;
          for (let i = 0; i < jobs.length; i += 1) {
            if (jobs[i].priority !== 'high') { insertAt = i; break; }
          }
          jobs.splice(insertAt, 0, job);
        } else {
          jobs.push(job);
        }
        pump();
      });
    },
    noteUnderrun,
    noteUnderrunCleared,
    pause: pauseQueue,
    resume: noteUnderrunCleared,
    kill(reason) {
      killCurrent(reason);
    },
  };
}

/**
 * RealtimeAnalysisQueue (docs/mix-transition-phase9.md §5.2): BPM,
 * downbeat, phrase, key, and vocal-activity analysis. Unchanged from
 * pre-Phase-9C behavior — same singleton, same createAnalysisQueue()
 * defaults.
 */
export function getAnalysisQueue() {
  if (!defaultQueue) {
    defaultQueue = createAnalysisQueue();
  }
  return defaultQueue;
}

/**
 * StemPreparationQueue (docs/mix-transition-phase9.md §5.2/§5.3):
 * full-track Demucs separation only, for both the Phase 8 outgoing-track
 * pass and the Phase 9B next/next+1 prefetch. A completely separate
 * createAnalysisQueue() instance from getAnalysisQueue() — its own serial
 * FIFO (concurrency 1, per §5.3), its own pause/kill state — so a
 * long-running Demucs job here can never sit in front of, or get paused/
 * killed alongside, a realtime BPM/phrase job on the other queue.
 */
export function getStemPreparationQueue() {
  if (!defaultStemQueue) {
    defaultStemQueue = createAnalysisQueue();
  }
  return defaultStemQueue;
}

/** Test-only: replace or clear the process-wide realtime analysis queue. */
export function setAnalysisQueueForTest(queue) {
  defaultQueue = queue;
}

/** Test-only: replace or clear the process-wide stem-preparation queue. */
export function setStemPreparationQueueForTest(queue) {
  defaultStemQueue = queue;
}
