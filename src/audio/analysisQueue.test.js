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
