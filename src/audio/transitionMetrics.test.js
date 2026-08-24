import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordTransition, getTransitionMetrics, resetTransitionMetrics } from './transitionMetrics.js';

test.beforeEach(() => {
  resetTransitionMetrics();
});

test('getTransitionMetrics starts empty', () => {
  const metrics = getTransitionMetrics();
  assert.deepEqual(metrics, {
    totalTransitions: 0,
    selected: {},
    stemCache: {
      outgoingHit: 0,
      outgoingMiss: 0,
      incomingHit: 0,
      incomingMiss: 0,
    },
  });
});

test('recordTransition increments totalTransitions and buckets by camelCase mode key', () => {
  recordTransition({ selected: 'stem-mix' });
  recordTransition({ selected: 'stem-mix' });
  recordTransition({ selected: 'beatmix' });
  recordTransition({ selected: 'phrase-crossfade' });
  recordTransition({ selected: 'crossfade' });
  recordTransition({ selected: 'tail-fade' });

  const metrics = getTransitionMetrics();
  assert.equal(metrics.totalTransitions, 6);
  assert.deepEqual(metrics.selected, {
    stemMix: 2,
    beatmix: 1,
    phraseCrossfade: 1,
    crossfade: 1,
    tailFade: 1,
  });
});

test('recordTransition tallies an unrecognized mode string under its own key rather than dropping it', () => {
  recordTransition({ selected: 'some-future-mode' });
  const metrics = getTransitionMetrics();
  assert.equal(metrics.totalTransitions, 1);
  assert.deepEqual(metrics.selected, { 'some-future-mode': 1 });
});

test('recordTransition tallies a missing/undefined selected mode as "unknown" instead of throwing', () => {
  recordTransition({});
  const metrics = getTransitionMetrics();
  assert.equal(metrics.totalTransitions, 1);
  assert.deepEqual(metrics.selected, { unknown: 1 });
});

test('recordTransition tracks stemCache hit/miss per side independently', () => {
  recordTransition({ selected: 'stem-mix', stemCache: { outgoing: 'hit', incoming: 'hit' } });
  recordTransition({ selected: 'beatmix', stemCache: { outgoing: 'hit', incoming: 'miss' } });
  recordTransition({ selected: 'crossfade', stemCache: { outgoing: null, incoming: null } });

  const metrics = getTransitionMetrics();
  assert.deepEqual(metrics.stemCache, {
    outgoingHit: 2,
    outgoingMiss: 0,
    incomingHit: 1,
    incomingMiss: 1,
  });
});

test('recordTransition without a stemCache argument leaves the stemCache counters untouched', () => {
  recordTransition({ selected: 'beatmix' });
  const metrics = getTransitionMetrics();
  assert.deepEqual(metrics.stemCache, {
    outgoingHit: 0,
    outgoingMiss: 0,
    incomingHit: 0,
    incomingMiss: 0,
  });
});

test('getTransitionMetrics returns an independent snapshot each call (mutating the result does not corrupt state)', () => {
  recordTransition({ selected: 'beatmix' });
  const first = getTransitionMetrics();
  first.totalTransitions = 999;
  first.selected.beatmix = 999;
  first.stemCache.outgoingHit = 999;

  const second = getTransitionMetrics();
  assert.equal(second.totalTransitions, 1);
  assert.equal(second.selected.beatmix, 1);
  assert.equal(second.stemCache.outgoingHit, 0);
});

test('resetTransitionMetrics clears all accumulated counts', () => {
  recordTransition({ selected: 'stem-mix', stemCache: { outgoing: 'hit', incoming: 'hit' } });
  resetTransitionMetrics();
  assert.deepEqual(getTransitionMetrics(), {
    totalTransitions: 0,
    selected: {},
    stemCache: {
      outgoingHit: 0,
      outgoingMiss: 0,
      incomingHit: 0,
      incomingMiss: 0,
    },
  });
});
