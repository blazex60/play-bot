import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAnalysisQueue } from './analysisQueue.js';

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
