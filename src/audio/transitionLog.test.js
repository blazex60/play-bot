import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransitionPlanReport,
  formatTransitionPlanLog,
  logTransitionPlan,
} from './transitionLog.js';
import { getTransitionMetrics, resetTransitionMetrics } from './transitionMetrics.js';

test.beforeEach(() => {
  resetTransitionMetrics();
});

const outgoingTrack = { title: 'Song A' };
const incomingTrack = { title: 'Song B' };

function beatmixPlan({ exitStartSec = 183.2, exitBarIndex = 92, entrySec = 0, entryBarIndex = 0, bars = 4, fadeSec = 8, confidence = 0.82 } = {}) {
  return {
    mode: 'beatmix',
    eligible: true,
    confidence,
    fadeSec,
    outgoing: { exitStartSec, exitBarIndex },
    incoming: { entrySec, entryBarIndex },
    sync: { bars, beatsPerBar: 4, phaseOffsetSec: 0 },
  };
}

function stemMixPlan(overrides = {}) {
  return { ...beatmixPlan(overrides), mode: 'stem-mix', stems: {} };
}

function phraseCrossfadePlan({ startSec = 184, exitBarIndex = 90, entrySec = 0.2, entryBarIndex = 0, fadeSec = 6, confidence = 0.6 } = {}) {
  return {
    mode: 'phrase-crossfade',
    eligible: true,
    confidence,
    fadeSec,
    startSec,
    exitBarIndex,
    entrySec,
    entryBarIndex,
  };
}

function rejected(reasons) {
  return { mode: null, eligible: false, reasons };
}

// --- buildTransitionPlanReport --------------------------------------------

test('buildTransitionPlanReport: stem-mix selected — all three candidates eligible', () => {
  const rawPlan = beatmixPlan(); // ladder still finds beatmix eligible too
  const stemPlan = stemMixPlan({ bars: 8, fadeSec: 16, confidence: 0.91 });
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: { lastVocalEndSec: 190 },
    incomingAnalysis: { firstVocalStartSec: 12.4 },
    rawPlan,
    stemPlan,
    stemCacheAttempted: true,
    outgoingStemsCached: true,
    incomingStemsCached: true,
    plannedMode: 'stem-mix',
  });

  assert.equal(report.from, 'Song A');
  assert.equal(report.to, 'Song B');
  assert.equal(report.selected, 'stem-mix');
  assert.deepEqual(report.candidates.beatmix, { eligible: true, bars: 4, fadeSec: 8, score: 0.82 });
  assert.deepEqual(report.candidates.stemMix, { eligible: true, bars: 8, fadeSec: 16, score: 0.91 });
  assert.deepEqual(report.candidates.phraseCrossfade, { eligible: false, reason: 'not-evaluated-beatmix-selected' });
  assert.deepEqual(report.stemCache, { outgoing: 'hit', incoming: 'hit' });
  // outgoing still singing (190) past the exit point (183.2) -> vocalActive
  assert.equal(report.exit.vocalActive, true);
  assert.equal(report.exit.sec, 183.2);
  assert.equal(report.exit.bar, 92);
  assert.equal(report.entry.firstVocalSec, 12.4);
});

test('buildTransitionPlanReport: beatmix short-circuits phrase-crossfade AND stem-mix as not-evaluated', () => {
  const rawPlan = beatmixPlan();
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: {},
    incomingAnalysis: {},
    rawPlan,
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'beatmix',
  });

  assert.equal(report.selected, 'beatmix');
  assert.deepEqual(report.candidates.beatmix, { eligible: true, bars: 4, fadeSec: 8, score: 0.82 });
  assert.deepEqual(report.candidates.phraseCrossfade, { eligible: false, reason: 'not-evaluated-beatmix-selected' });
  assert.deepEqual(report.candidates.stemMix, { eligible: false, reason: 'not-evaluated-beatmix-selected' });
  assert.deepEqual(report.stemCache, { outgoing: null, incoming: null });
});

test('buildTransitionPlanReport: reject case — phrase-crossfade wins, beatmix/stem-mix both report real rejection reasons', () => {
  // beatmix rejected -> phrase-crossfade attempted and eligible -> ladder returns
  // phrase-crossfade with fallbackFrom = [beatmixReason].
  const rawPlan = { ...phraseCrossfadePlan(), fallbackFrom: ['no-entry-candidate'] };
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: { lastVocalEndSec: 180 },
    incomingAnalysis: { firstVocalStartSec: null },
    rawPlan,
    stemPlan: null,
    stemCacheAttempted: true,
    outgoingStemsCached: true,
    incomingStemsCached: false, // incoming side missed the stem cache
    plannedMode: 'phrase-crossfade',
  });

  assert.equal(report.selected, 'phrase-crossfade');
  assert.deepEqual(report.candidates.beatmix, { eligible: false, reason: 'no-entry-candidate' });
  assert.deepEqual(report.candidates.stemMix, { eligible: false, reason: 'stem-cache-miss' });
  assert.deepEqual(report.candidates.phraseCrossfade, { eligible: true, fadeSec: 6, score: 0.6 });
  assert.deepEqual(report.stemCache, { outgoing: 'hit', incoming: 'miss' });
});

test('buildTransitionPlanReport: both beatmix and phrase-crossfade rejected — fallbackFrom has two reasons in ladder order', () => {
  const rawPlan = {
    mode: 'crossfade',
    fadeSec: 3,
    startSec: 190,
    confidence: 0.8,
    fallbackFrom: ['beat-confidence-low', 'no-phrase-data'],
  };
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: { lastVocalEndSec: 195 },
    incomingAnalysis: {},
    rawPlan,
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'crossfade',
  });

  assert.equal(report.selected, 'crossfade');
  assert.deepEqual(report.candidates.beatmix, { eligible: false, reason: 'beat-confidence-low' });
  assert.deepEqual(report.candidates.phraseCrossfade, { eligible: false, reason: 'no-phrase-data' });
  // legacy crossfade has no bar concept and always enters at native 0.
  assert.equal(report.exit.bar, null);
  assert.equal(report.entry.sec, 0);
  assert.equal(report.entry.bar, null);
});

test('buildTransitionPlanReport: stem-mix attempted but ineligible reports planStemTransition()\'s own reject reason', () => {
  const rawPlan = { ...phraseCrossfadePlan(), fallbackFrom: ['tempo-ratio-exceeds-hard'] };
  const stemPlan = rejected(['stem-mix-no-invocal-fade-room']);
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: {},
    incomingAnalysis: {},
    rawPlan,
    stemPlan,
    stemCacheAttempted: true,
    outgoingStemsCached: true,
    incomingStemsCached: true,
    plannedMode: 'phrase-crossfade',
  });

  assert.deepEqual(report.candidates.stemMix, { eligible: false, reason: 'stem-mix-no-invocal-fade-room' });
  assert.deepEqual(report.stemCache, { outgoing: 'hit', incoming: 'hit' });
});

test('buildTransitionPlanReport: exit.vocalActive is false when the exit point is already past the last vocal frame', () => {
  const rawPlan = beatmixPlan({ exitStartSec: 183.2 });
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: { lastVocalEndSec: 150 }, // vocals ended well before the exit
    incomingAnalysis: {},
    rawPlan,
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'beatmix',
  });
  assert.equal(report.exit.vocalActive, false);
});

test('buildTransitionPlanReport: exit.vocalActive is null when vocal analysis is unavailable, not falsely false', () => {
  const rawPlan = beatmixPlan();
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: { lastVocalEndSec: null },
    incomingAnalysis: {},
    rawPlan,
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'beatmix',
  });
  assert.equal(report.exit.vocalActive, null);
});

// --- formatTransitionPlanLog -----------------------------------------------

test('formatTransitionPlanLog: renders the §3.2 shape with from/to/selected and every candidate block', () => {
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: { lastVocalEndSec: 190 },
    incomingAnalysis: { firstVocalStartSec: 12.4 },
    rawPlan: beatmixPlan(),
    stemPlan: stemMixPlan({ bars: 8, fadeSec: 16, confidence: 0.91 }),
    stemCacheAttempted: true,
    outgoingStemsCached: true,
    incomingStemsCached: true,
    plannedMode: 'stem-mix',
  });
  report.selected = 'stem-mix';
  report.downgradedFrom = null;

  const text = formatTransitionPlanLog(report);
  assert.match(text, /^\[MIX PLAN\]/);
  assert.match(text, /from="Song A"/);
  assert.match(text, /to="Song B"/);
  assert.match(text, /selected=stem-mix/);
  assert.match(text, /beatmix:\n {2}eligible=true\n {2}bars=4\n {2}fadeSec=8\.00\n {2}score=0\.820/);
  assert.match(text, /stemMix:\n {2}eligible=true\n {2}bars=8\n {2}fadeSec=16\.00\n {2}score=0\.910/);
  assert.match(text, /stemCache:\n {2}outgoing=HIT\n {2}incoming=HIT/);
  assert.match(text, /exit:\n {2}sec=183\.20\n {2}bar=92\n {2}vocalActive=true/);
  assert.match(text, /entry:\n {2}sec=0\.00\n {2}bar=0\n {2}firstVocalSec=12\.40/);
});

test('formatTransitionPlanLog: an ineligible candidate prints its reason, not bars/fadeSec/score', () => {
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: {},
    incomingAnalysis: {},
    rawPlan: beatmixPlan(),
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'beatmix',
  });
  report.selected = 'beatmix';
  const text = formatTransitionPlanLog(report);
  assert.match(text, /stemMix:\n {2}eligible=false\n {2}reason=not-evaluated-beatmix-selected/);
  assert.doesNotMatch(text.split('stemMix:')[1].split('phraseCrossfade:')[0], /bars=/);
});

test('formatTransitionPlanLog: includes downgradedFrom when the report carries one', () => {
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: {},
    incomingAnalysis: {},
    rawPlan: beatmixPlan(),
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'beatmix',
  });
  report.selected = 'crossfade';
  report.downgradedFrom = 'beatmix';
  const text = formatTransitionPlanLog(report);
  assert.match(text, /selected=crossfade\ndowngradedFrom=beatmix/);
});

// --- logTransitionPlan -------------------------------------------------------

test('logTransitionPlan always records metrics, even with debug off', () => {
  const report = { selected: 'beatmix', stemCache: { outgoing: 'hit', incoming: 'miss' }, candidates: {} };
  logTransitionPlan(report, { debug: false, logger: { log: () => { throw new Error('must not log'); } } });
  const metrics = getTransitionMetrics();
  assert.equal(metrics.totalTransitions, 1);
  assert.equal(metrics.selected.beatmix, 1);
  assert.equal(metrics.stemCache.outgoingHit, 1);
  assert.equal(metrics.stemCache.incomingMiss, 1);
});

test('logTransitionPlan prints the formatted block through the injected logger when debug is on', () => {
  const report = buildTransitionPlanReport({
    outgoingTrack,
    incomingTrack,
    outgoingAnalysis: {},
    incomingAnalysis: {},
    rawPlan: beatmixPlan(),
    stemPlan: null,
    stemCacheAttempted: false,
    outgoingStemsCached: false,
    incomingStemsCached: false,
    plannedMode: 'beatmix',
  });
  report.selected = 'beatmix';

  const logged = [];
  logTransitionPlan(report, { debug: true, logger: { log: (msg) => logged.push(msg) } });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^\[MIX PLAN\]/);
  assert.match(logged[0], /selected=beatmix/);

  const metrics = getTransitionMetrics();
  assert.equal(metrics.totalTransitions, 1);
});

test('logTransitionPlan respects MIX_DEBUG=true from the environment when no explicit debug flag is passed', () => {
  const previous = process.env.MIX_DEBUG;
  process.env.MIX_DEBUG = 'true';
  try {
    const report = { selected: 'crossfade', stemCache: {}, candidates: { beatmix: { eligible: false, reason: 'x' }, stemMix: { eligible: false, reason: 'x' }, phraseCrossfade: { eligible: false, reason: 'x' } } };
    const logged = [];
    logTransitionPlan(report, { logger: { log: (msg) => logged.push(msg) } });
    assert.equal(logged.length, 1);
  } finally {
    if (previous === undefined) delete process.env.MIX_DEBUG;
    else process.env.MIX_DEBUG = previous;
  }
});

test('logTransitionPlan stays silent by default (MIX_DEBUG unset) but still records metrics', () => {
  const previous = process.env.MIX_DEBUG;
  delete process.env.MIX_DEBUG;
  try {
    const report = { selected: 'tail-fade', stemCache: {}, candidates: {} };
    const logged = [];
    logTransitionPlan(report, { logger: { log: (msg) => logged.push(msg) } });
    assert.equal(logged.length, 0);
    assert.equal(getTransitionMetrics().selected.tailFade, 1);
  } finally {
    if (previous === undefined) delete process.env.MIX_DEBUG;
    else process.env.MIX_DEBUG = previous;
  }
});
