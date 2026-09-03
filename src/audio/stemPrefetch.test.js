import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StemPreparationState,
  StemPrefetchPriority,
  StemPrefetchTracker,
} from './stemPrefetch.js';

test('stemPrefetch: queue() creates a fresh QUEUED entry with §4.3 fields', () => {
  const tracker = new StemPrefetchTracker();
  const before = Date.now();
  const entry = tracker.queue('vid-b', StemPrefetchPriority.HIGH);
  assert.equal(entry.videoId, 'vid-b');
  assert.equal(entry.priority, StemPrefetchPriority.HIGH);
  assert.equal(entry.state, StemPreparationState.QUEUED);
  assert.ok(entry.queuedAt >= before);
  assert.equal(entry.startedAt, null);
  assert.equal(entry.completedAt, null);
  assert.equal(tracker.get('vid-b'), entry);
});

test('stemPrefetch: get() returns null for an untracked videoId', () => {
  const tracker = new StemPrefetchTracker();
  assert.equal(tracker.get('nope'), null);
});

test('stemPrefetch: queue() is idempotent — a second call for the same videoId returns the same entry', () => {
  const tracker = new StemPrefetchTracker();
  const first = tracker.queue('vid-c', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-c');
  const second = tracker.queue('vid-c', StemPrefetchPriority.LOW);
  assert.equal(second, first);
  assert.equal(second.state, StemPreparationState.PROCESSING);
});

test('stemPrefetch: queue() escalates LOW to HIGH in place without resetting state', () => {
  const tracker = new StemPrefetchTracker();
  const entry = tracker.queue('vid-c', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-c');
  const escalated = tracker.queue('vid-c', StemPrefetchPriority.HIGH);
  assert.equal(escalated, entry);
  assert.equal(escalated.priority, StemPrefetchPriority.HIGH);
  assert.equal(escalated.state, StemPreparationState.PROCESSING, 'escalation must not reset in-flight state');
});

test('stemPrefetch: queue() never downgrades an existing HIGH entry back to LOW', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-b', StemPrefetchPriority.HIGH);
  const again = tracker.queue('vid-b', StemPrefetchPriority.LOW);
  assert.equal(again.priority, StemPrefetchPriority.HIGH);
});

test('stemPrefetch: state machine QUEUED -> PROCESSING -> READY', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-b', StemPrefetchPriority.HIGH);
  tracker.markProcessing('vid-b');
  assert.equal(tracker.get('vid-b').state, StemPreparationState.PROCESSING);
  assert.ok(tracker.get('vid-b').startedAt != null);
  tracker.markReady('vid-b');
  const entry = tracker.get('vid-b');
  assert.equal(entry.state, StemPreparationState.READY);
  assert.ok(entry.completedAt != null);
});

test('stemPrefetch: state machine QUEUED -> PROCESSING -> FAILED', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-c', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-c');
  tracker.markFailed('vid-c');
  const entry = tracker.get('vid-c');
  assert.equal(entry.state, StemPreparationState.FAILED);
  assert.ok(entry.completedAt != null);
});

test('stemPrefetch: markProcessing() only stamps startedAt once per PROCESSING run', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-b', StemPrefetchPriority.HIGH);
  tracker.markProcessing('vid-b');
  const first = tracker.get('vid-b').startedAt;
  tracker.markProcessing('vid-b');
  assert.equal(tracker.get('vid-b').startedAt, first);
});

test('stemPrefetch: mark* calls on an untracked videoId are a no-op, not a crash', () => {
  const tracker = new StemPrefetchTracker();
  assert.doesNotThrow(() => {
    tracker.markProcessing('ghost');
    tracker.markReady('ghost');
    tracker.markFailed('ghost');
  });
  assert.equal(tracker.get('ghost'), null);
});

test('stemPrefetch: queue()/mark*() ignore a falsy videoId', () => {
  const tracker = new StemPrefetchTracker();
  assert.equal(tracker.queue(null, StemPrefetchPriority.HIGH), null);
  assert.equal(tracker.queue(undefined, StemPrefetchPriority.HIGH), null);
  assert.equal(tracker.snapshot().length, 0);
});

test('stemPrefetch: a FAILED entry can be retried (queue() leaves it alone, caller re-marks it)', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-c', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-c');
  tracker.markFailed('vid-c');
  // Simulate the track reappearing in the prefetch window and being retried.
  const retried = tracker.queue('vid-c', StemPrefetchPriority.LOW);
  assert.equal(retried.state, StemPreparationState.FAILED, 'queue() must not silently reset a terminal state');
  tracker.markProcessing('vid-c');
  assert.equal(tracker.get('vid-c').state, StemPreparationState.PROCESSING);
});

test('stemPrefetch: prune() drops entries no longer in the active set', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-b', StemPrefetchPriority.HIGH);
  tracker.markProcessing('vid-b');
  tracker.markReady('vid-b');
  tracker.queue('vid-old', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-old');
  tracker.markFailed('vid-old');

  tracker.prune(['vid-b']);

  assert.ok(tracker.get('vid-b'), 'active videoId must survive prune');
  assert.equal(tracker.get('vid-old'), null, 'stale terminal-state entry must be pruned');
});

test('stemPrefetch: prune() leaves an in-flight (QUEUED/PROCESSING) entry alone even if no longer active', () => {
  // §4's own note: no cancellation API exists for an in-flight Demucs run,
  // so a track that fell out of the prefetch window (skip/reorder/remove)
  // must not have its bookkeeping yanked out from under the still-running
  // job — only a later prune(), once that entry reaches a terminal state,
  // should ever remove it.
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-c', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-c');

  tracker.prune([]);
  assert.ok(tracker.get('vid-c'), 'in-flight entry must survive a prune where it is not in the active set');

  tracker.markReady('vid-c');
  tracker.prune([]);
  assert.equal(tracker.get('vid-c'), null, 'a since-completed entry is prunable on the next call');
});

test('stemPrefetch: counts() tallies entries by state', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-a', StemPrefetchPriority.HIGH);
  tracker.queue('vid-b', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-b');
  tracker.queue('vid-c', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-c');
  tracker.markReady('vid-c');
  tracker.queue('vid-d', StemPrefetchPriority.LOW);
  tracker.markProcessing('vid-d');
  tracker.markFailed('vid-d');

  const counts = tracker.counts();
  assert.equal(counts[StemPreparationState.QUEUED], 1);
  assert.equal(counts[StemPreparationState.PROCESSING], 1);
  assert.equal(counts[StemPreparationState.READY], 1);
  assert.equal(counts[StemPreparationState.FAILED], 1);
});

test('stemPrefetch: snapshot() returns independent copies, not live references', () => {
  const tracker = new StemPrefetchTracker();
  tracker.queue('vid-b', StemPrefetchPriority.HIGH);
  const snap = tracker.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].videoId, 'vid-b');
  snap[0].state = StemPreparationState.READY;
  assert.equal(tracker.get('vid-b').state, StemPreparationState.QUEUED, 'mutating a snapshot entry must not affect tracker state');
});
