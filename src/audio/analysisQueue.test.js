import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createAnalysisQueue,
  getAnalysisQueue,
  getStemPreparationQueue,
  setAnalysisQueueForTest,
  setStemPreparationQueueForTest,
} from './analysisQueue.js';

function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.killed = false;
  proc.kill = (sig) => {
    proc.killed = true;
    proc.lastSignal = sig;
    queueMicrotask(() => proc.emit('close', sig === 'SIGKILL' ? 1 : 0));
  };
  return proc;
}

test('analysisQueue runs jobs one at a time', async () => {
  const order = [];
  const queue = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  const slow = queue.enqueue(async () => {
    order.push('a-start');
    await new Promise((r) => setTimeout(r, 30));
    order.push('a-end');
    return 1;
  });
  const fast = queue.enqueue(async () => {
    order.push('b');
    return 2;
  });
  const [a, b] = await Promise.all([slow, fast]);
  assert.equal(a, 1);
  assert.equal(b, 2);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('analysisQueue kills the job after underrun stop timeout', async () => {
  let now = 1000;
  const queue = createAnalysisQueue({
    useNice: false,
    spawnFn: () => fakeProc(),
    pauseAfterUnderrunMs: 10,
    maxStoppedMs: 15,
    clock: () => now,
  });

  const job = queue.enqueue(() => new Promise(() => {
    // Resolved/rejected by SIGSTOP timeout via killCurrent.
  }));

  queue.noteUnderrun();
  now = 1020;
  queue.noteUnderrun();
  now = 1040;
  queue.noteUnderrun();

  await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
});

test('analysisQueue ignores underrunClear from a stream that is not underrunning', async () => {
  let now = 1000;
  let continued = 0;
  const queue = createAnalysisQueue({
    useNice: false,
    spawnFn: () => fakeProc(),
    pauseAfterUnderrunMs: 10,
    maxStoppedMs: 10_000,
    clock: () => now,
  });
  const originalKill = process.kill;
  process.kill = (pid, sig) => {
    if (sig === 'SIGCONT') continued += 1;
  };
  try {
    const job = queue.enqueue(() => new Promise(() => {}));
    const a = { id: 'guild-a' };
    const b = { id: 'guild-b' };
    queue.noteUnderrun(b);
    now = 1020;
    queue.noteUnderrun(b);
    assert.equal(queue.isPaused, true);
    queue.noteUnderrunCleared(a);
    assert.equal(queue.isPaused, true);
    assert.equal(continued, 0);
    queue.kill('test');
    await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
  } finally {
    process.kill = originalKill;
  }
});

test('queue.kill() SIGKILLs a subprocess spawned via spawnNice, even without the job checking signal', async () => {
  // Regression for PR #31 review: analyzeTrackFile()'s sub-analysis calls do
  // not thread `signal` down into spawnCapture(), but that's fine because
  // spawnNice() registers every child, and pump()'s finally block kills all
  // registered children unconditionally on every job settlement (including
  // an abort) — independent of whether the job function itself ever reads
  // `signal`.
  const queue = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  let spawnedProc = null;
  const job = queue.enqueue(({ spawnNice }) => {
    spawnedProc = spawnNice('ffmpeg', ['-i', 'in.wav']);
    // Never resolves on its own — only killCurrent()/abort can end this job,
    // simulating a job that never inspects `signal`.
    return new Promise(() => {});
  });
  await new Promise((resolve) => setTimeout(resolve, 5)); // let the job start and spawn.
  assert.ok(spawnedProc, 'expected the job to have spawned a child');
  assert.equal(spawnedProc.killed, false);

  queue.kill('underrun');
  await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
  assert.equal(spawnedProc.killed, true, 'the spawned child must be killed even though the job never checked signal');
  assert.equal(spawnedProc.lastSignal, 'SIGKILL');
});

// --- Phase 9C (docs/mix-transition-phase9.md §5): dedicated stem queue ---

test('getAnalysisQueue() and getStemPreparationQueue() are independent singletons (§5.2)', () => {
  setAnalysisQueueForTest(null);
  setStemPreparationQueueForTest(null);
  try {
    const realtime = getAnalysisQueue();
    const stem = getStemPreparationQueue();
    assert.notEqual(realtime, stem, 'the realtime and stem-preparation queues must be two separate instances');
    assert.equal(getAnalysisQueue(), realtime, 'getAnalysisQueue() keeps returning the same singleton on repeat calls');
    assert.equal(getStemPreparationQueue(), stem, 'getStemPreparationQueue() keeps returning the same singleton on repeat calls');
  } finally {
    setAnalysisQueueForTest(null);
    setStemPreparationQueueForTest(null);
  }
});

test('setStemPreparationQueueForTest overrides only the stem singleton, leaving getAnalysisQueue() untouched', () => {
  setAnalysisQueueForTest(null);
  setStemPreparationQueueForTest(null);
  try {
    const originalRealtime = getAnalysisQueue();
    const fakeStem = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
    setStemPreparationQueueForTest(fakeStem);
    assert.equal(getStemPreparationQueue(), fakeStem);
    assert.equal(getAnalysisQueue(), originalRealtime,
      'overriding the stem-preparation queue must not disturb the realtime analysis queue singleton');
  } finally {
    setAnalysisQueueForTest(null);
    setStemPreparationQueueForTest(null);
  }
});

test('queue.pause()/resume() apply immediately, unlike noteUnderrun()\'s debounced pause (§5.4 "Playback Safety")', async () => {
  let continued = 0;
  const originalKill = process.kill;
  const queue = createAnalysisQueue({
    useNice: false,
    spawnFn: () => fakeProc(),
    // A debounce window far longer than this test runs for: if pause()
    // routed through the same debounced path as noteUnderrun(), isPaused
    // would still be false by the time we assert on it.
    pauseAfterUnderrunMs: 10_000,
  });
  process.kill = (pid, sig) => {
    if (sig === 'SIGCONT') continued += 1;
  };
  try {
    const job = queue.enqueue(({ spawnNice }) => {
      spawnNice('ffmpeg', ['-i', 'in.wav']); // registers a child so SIGSTOP/SIGCONT have something to signal
      return new Promise(() => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the job actually start and spawn (running=true)
    assert.equal(queue.isPaused, false);

    queue.pause('cpu-pressure');
    assert.equal(queue.isPaused, true, 'pause() must apply immediately, without waiting for pauseAfterUnderrunMs');

    queue.resume('cpu-pressure');
    assert.equal(queue.isPaused, false);
    assert.equal(continued, 1, 'resume() must SIGCONT the paused child');

    queue.kill('test cleanup');
    await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
  } finally {
    process.kill = originalKill;
  }
});

test('queue.pause() eventually kills a stuck job through the same maxStoppedMs timeout noteUnderrun() uses', async () => {
  let now = 1000;
  const queue = createAnalysisQueue({
    useNice: false,
    spawnFn: () => fakeProc(),
    maxStoppedMs: 15,
    clock: () => now,
  });
  const job = queue.enqueue(() => new Promise(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 5));

  queue.pause('cpu-pressure');
  assert.equal(queue.isPaused, true);
  now = 1020; // past maxStoppedMs since the pause was applied
  queue.pause('cpu-pressure'); // re-signals the still-paused source; must notice the timeout and kill

  await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
});

test('queue.pause() kills a stuck job on its own after maxStoppedMs, with no second pause() call (Codex review, PR #45, round 4, P2)', async () => {
  // Unlike noteUnderrun()'s debounced path (naturally re-invoked as long as
  // the mixer keeps reporting the underrun, which is what re-checks
  // maxStoppedMs on each call), a single explicit pause() is edge-triggered
  // — a CPU-pressure monitor calls it once and is expected to call resume()
  // once conditions clear. If that resume() never comes (the monitor or
  // owning player disappears), nothing without a real timer would ever
  // re-check the timeout, leaving the paused job's SIGSTOP'd children
  // stopped forever. Uses a real setTimeout (not the injectable `clock`,
  // which only gates the *value* used in the elapsed-time comparison, not
  // when that comparison itself re-runs) with a short maxStoppedMs so the
  // test doesn't have to wait long.
  const queue = createAnalysisQueue({
    useNice: false,
    spawnFn: () => fakeProc(),
    maxStoppedMs: 15,
  });
  const job = queue.enqueue(() => new Promise(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 5));

  queue.pause('cpu-pressure'); // exactly once — no follow-up call of any kind
  assert.equal(queue.isPaused, true);

  await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
});

test('queue.pause() and noteUnderrun() share pause bookkeeping: the queue stays paused until every source clears', async () => {
  let now = 1000;
  let continued = 0;
  const originalKill = process.kill;
  const queue = createAnalysisQueue({
    useNice: false,
    spawnFn: () => fakeProc(),
    pauseAfterUnderrunMs: 10,
    clock: () => now,
  });
  process.kill = (pid, sig) => {
    if (sig === 'SIGCONT') continued += 1;
  };
  try {
    const job = queue.enqueue(({ spawnNice }) => {
      spawnNice('ffmpeg', ['-i', 'in.wav']);
      return new Promise(() => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const underrunSource = { id: 'mixer-underrun' };
    queue.noteUnderrun(underrunSource);
    now = 1020;
    queue.noteUnderrun(underrunSource); // clears the debounce window, actually pauses
    assert.equal(queue.isPaused, true);

    queue.pause('cpu-pressure'); // a second, independent pause source
    assert.equal(queue.isPaused, true);

    queue.noteUnderrunCleared(underrunSource);
    assert.equal(queue.isPaused, true, 'must stay paused — the explicit pause() source has not cleared yet');
    assert.equal(continued, 0);

    queue.resume('cpu-pressure');
    assert.equal(queue.isPaused, false, 'clearing the last remaining pause source must resume the queue');
    assert.equal(continued, 1);

    queue.kill('test cleanup');
    await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
  } finally {
    process.kill = originalKill;
  }
});

test('pausing one queue instance never touches a separate instance from the same factory (two independent lanes, §5.2)', async () => {
  const realtime = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  const stem = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  const realtimeJob = realtime.enqueue(() => new Promise(() => {}));
  const stemJob = stem.enqueue(() => new Promise(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 5));

  stem.pause('cpu-pressure');
  assert.equal(stem.isPaused, true);
  assert.equal(realtime.isPaused, false,
    'pausing the stem-preparation queue must not pause the realtime queue — a heavy Demucs job on one lane cannot block the other');

  realtime.kill('test cleanup');
  stem.kill('test cleanup');
  await assert.rejects(realtimeJob, (err) => err.code === 'ANALYSIS_KILLED');
  await assert.rejects(stemJob, (err) => err.code === 'ANALYSIS_KILLED');
});

// --- Codex review (PR #45 round 1) ---

test('enqueue({priority: "high"}) runs ahead of already-pending normal-priority jobs', async () => {
  // Codex review (PR #45, P1): a HIGH (next-track) job requested after a
  // LOW (next+1) job is already sitting in the pending queue must still run
  // first — plain FIFO call order previously meant it did not.
  const order = [];
  const queue = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  const blocker = queue.enqueue(async () => {
    order.push('blocker-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('blocker-end');
  });
  await new Promise((resolve) => setTimeout(resolve, 5)); // let the blocker actually start running

  const low = queue.enqueue(async () => { order.push('low'); }, { priority: 'low' });
  const high = queue.enqueue(async () => { order.push('high'); }, { priority: 'high' });

  await Promise.all([blocker, low, high]);
  assert.deepEqual(order, ['blocker-start', 'blocker-end', 'high', 'low']);
});

test('enqueue({priority: "high"}) preserves relative order among multiple high-priority jobs', async () => {
  const order = [];
  const queue = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  const blocker = queue.enqueue(() => new Promise((resolve) => setTimeout(resolve, 20)));
  await new Promise((resolve) => setTimeout(resolve, 5));

  const normal = queue.enqueue(async () => { order.push('normal'); });
  const highA = queue.enqueue(async () => { order.push('high-a'); }, { priority: 'high' });
  const highB = queue.enqueue(async () => { order.push('high-b'); }, { priority: 'high' });

  await Promise.all([blocker, normal, highA, highB]);
  assert.deepEqual(order, ['high-a', 'high-b', 'normal']);
});

test('pause() called while idle keeps a subsequently enqueued job paused at spawn time (§5.4)', async () => {
  // Codex review (PR #45, P2): pause()/noteUnderrun() can arrive while the
  // queue has no job running yet (e.g. a mixer underrun fires before the
  // async cache check ahead of the next stem job's dispatch). Without this,
  // pump() unconditionally reset `paused` to false the instant the next job
  // started, so a CPU-heavy job could start fully unpaused during the exact
  // pressure that was supposed to suppress it.
  let spawnedProc = null;
  let sigstops = 0;
  const originalKill = process.kill;
  const queue = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });

  assert.equal(queue.isRunning, false);
  queue.pause('cpu-pressure');
  // While idle there is no running job to SIGSTOP, so isPaused itself stays
  // false here — pauseQueue() only records the source in underrunSources.
  // The actual regression this test guards is what pump() does with that
  // recorded source once a job DOES start, asserted below.
  assert.equal(queue.isPaused, false, 'nothing to pause yet while idle');

  process.kill = (pid, sig) => {
    if (sig === 'SIGSTOP') sigstops += 1;
  };
  try {
    const job = queue.enqueue(({ spawnNice }) => {
      spawnedProc = spawnNice('ffmpeg', ['-i', 'in.wav']);
      return new Promise(() => {});
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the job actually start

    assert.equal(queue.isPaused, true, 'the newly started job must inherit the pre-existing pause instead of clearing it');
    assert.ok(spawnedProc, 'expected the job to have spawned a child');
    assert.equal(sigstops, 1, 'a child spawned while already paused must be SIGSTOPed at register() time');

    queue.resume('cpu-pressure');
    queue.kill('test cleanup');
    await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
  } finally {
    process.kill = originalKill;
  }
});

test('killed analysis callback does not commit after abort', async () => {
  const queue = createAnalysisQueue({ useNice: false, spawnFn: () => fakeProc() });
  let committed = false;
  const job = queue.enqueue(async ({ signal }) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (signal.aborted) {
      const err = new Error('analysis killed');
      err.code = 'ANALYSIS_KILLED';
      throw err;
    }
    committed = true;
    return { version: 2 };
  });
  queue.kill('underrun');
  await assert.rejects(job, (err) => err.code === 'ANALYSIS_KILLED');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(committed, false);
});
