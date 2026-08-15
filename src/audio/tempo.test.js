import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  normalizeBpmToOctave,
  tempoRatio,
  canTempoMatch,
  buildTempoFilter,
  probeTempoBackend,
  resetTempoBackendProbeCache,
  compensateDurationSec,
  createSessionTempoState,
  resetSessionTempo,
  applySessionTempo,
  SOFT_LIMIT_RATIO,
  HARD_LIMIT_RATIO,
} from './tempo.js';

// --- normalizeBpmToOctave / tempoRatio -----------------------------------

test('tempoRatio matches directly when native and target are already in the same octave', () => {
  assert.equal(tempoRatio(120, 122), 122 / 120);
});

test('tempoRatio normalizes a half-tempo native BPM into the target octave before ratioing', () => {
  // A 60 BPM detection describing a track whose real groove is ~120: the
  // physical stretch needed to reach 122 is 122/120, not 122/60.
  assert.equal(tempoRatio(60, 122), 122 / 120);
});

test('tempoRatio normalizes a double-tempo native BPM into the target octave', () => {
  assert.equal(tempoRatio(240, 122), 122 / 120);
});

test('tempoRatio returns null for unrelated tempos (no octave of native falls near target)', () => {
  // 70 doubled is 140, still outside 300's [180, 420] band at any octave.
  assert.equal(tempoRatio(70, 300), null);
});

test('tempoRatio returns null for missing/invalid inputs', () => {
  assert.equal(tempoRatio(null, 120), null);
  assert.equal(tempoRatio(120, null), null);
  assert.equal(tempoRatio(0, 120), null);
  assert.equal(tempoRatio(120, -5), null);
});

test('normalizeBpmToOctave picks the in-band candidate closest to target, not just the raw value', () => {
  // 68 (dist 32) and 136=68*2 (dist 36) are both within [60, 140] of target
  // 100 — the raw value wins here because it is closer.
  assert.equal(normalizeBpmToOctave(68, 100), 68);
  // 63 (dist 37) and 126=63*2 (dist 26) are both in band — the doubled
  // candidate wins here because it is closer.
  assert.equal(normalizeBpmToOctave(63, 100), 126);
});

// --- canTempoMatch --------------------------------------------------------

test('canTempoMatch classifies within-soft-limit pairs as normal', () => {
  const result = canTempoMatch(120, 122); // ~1.67% deviation
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'normal');
  assert.ok(Math.abs(result.ratio - 122 / 120) < 1e-9);
});

test('canTempoMatch classifies 4-6% deviation as marginal but still ok', () => {
  const result = canTempoMatch(100, 105); // 5% deviation
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'marginal');
});

test('canTempoMatch rejects deviation beyond the hard limit', () => {
  const result = canTempoMatch(100, 110); // 10% deviation
  assert.equal(result.ok, false);
  assert.equal(result.tier, 'exceeds-hard');
});

test('canTempoMatch rejects unrelated tempos', () => {
  const result = canTempoMatch(70, 300);
  assert.equal(result.ok, false);
  assert.equal(result.ratio, null);
});

test('canTempoMatch treats the exact soft-limit boundary as normal, not marginal (float rounding)', () => {
  // 104/100 computes to 1.0400000000000000355... in IEEE 754 — a naive
  // `deviation > softLimit` comparison pushes the exact 4% boundary into
  // the marginal tier even though §8.3 means it inclusive ("4%以内").
  const result = canTempoMatch(100, 104);
  assert.equal(result.tier, 'normal');
});

test('canTempoMatch treats the exact hard-limit boundary as still matchable (float rounding)', () => {
  // 106/100 computes to 1.0600000000000000533... — same rounding issue at
  // the hard limit ("6%超" = over 6%, so exactly 6% must still be ok).
  const result = canTempoMatch(100, 106);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'marginal');
});

test('SOFT_LIMIT_RATIO and HARD_LIMIT_RATIO match Phase 7 §8.3 provisional values', () => {
  assert.equal(SOFT_LIMIT_RATIO, 0.04);
  assert.equal(HARD_LIMIT_RATIO, 0.06);
});

// --- buildTempoFilter ------------------------------------------------------

test('buildTempoFilter emits a rubberband filter for a normal-tier pair', () => {
  const result = buildTempoFilter({ nativeBpm: 120, targetBpm: 122, backend: 'rubberband' });
  assert.equal(result.backend, 'rubberband');
  assert.match(result.filter, /^rubberband=tempo=1\.0167$/);
});

test('buildTempoFilter emits a rubberband filter up to the hard limit', () => {
  const result = buildTempoFilter({ nativeBpm: 100, targetBpm: 105.9, backend: 'rubberband' }); // 5.9%
  assert.ok(result.filter);
  assert.equal(result.backend, 'rubberband');
});

test('buildTempoFilter refuses rubberband beyond the hard limit', () => {
  const result = buildTempoFilter({ nativeBpm: 100, targetBpm: 110, backend: 'rubberband' });
  assert.equal(result.filter, null);
  assert.equal(result.backend, null);
});

test('buildTempoFilter accepts the exact rubberband hard-limit boundary (float rounding)', () => {
  const result = buildTempoFilter({ nativeBpm: 100, targetBpm: 106, backend: 'rubberband' }); // exactly 6%
  assert.ok(result.filter);
  assert.equal(result.backend, 'rubberband');
});

test('buildTempoFilter restricts atempo to the soft limit (pitch also shifts)', () => {
  const withinSoft = buildTempoFilter({ nativeBpm: 100, targetBpm: 103, backend: 'atempo' }); // 3%
  assert.match(withinSoft.filter, /^atempo=1\.0300$/);

  const beyondSoft = buildTempoFilter({ nativeBpm: 100, targetBpm: 105, backend: 'atempo' }); // 5%
  assert.equal(beyondSoft.filter, null);
});

test('buildTempoFilter accepts the exact atempo soft-limit boundary (float rounding)', () => {
  const result = buildTempoFilter({ nativeBpm: 100, targetBpm: 104, backend: 'atempo' }); // exactly 4%
  assert.ok(result.filter);
  assert.equal(result.backend, 'atempo');
});

test('buildTempoFilter returns null for an unknown/absent backend', () => {
  const result = buildTempoFilter({ nativeBpm: 120, targetBpm: 122, backend: null });
  assert.equal(result.filter, null);
  assert.equal(result.backend, null);
  // ratio is still reported: a caller degrading through backends can reuse it.
  assert.ok(Math.abs(result.ratio - 122 / 120) < 1e-9);
});

test('buildTempoFilter returns a null ratio when tempos are unrelated regardless of backend', () => {
  const result = buildTempoFilter({ nativeBpm: 70, targetBpm: 300 });
  assert.equal(result.filter, null);
  assert.equal(result.ratio, null);
});

// --- probeTempoBackend -----------------------------------------------------

function fakeSpawn(stdout, code = 0) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit('data', stdout);
      proc.emit('close', code);
    });
    return proc;
  };
}

test('probeTempoBackend prefers rubberband when both filters are listed', async () => {
  resetTempoBackendProbeCache();
  const backend = await probeTempoBackend({
    spawnFn: fakeSpawn(' T.. rubberband      A->A       Apply time-stretching and pitch-shifting.\n T.. atempo          A->A       Adjust audio tempo.\n'),
  });
  assert.equal(backend, 'rubberband');
});

test('probeTempoBackend falls back to atempo when rubberband is absent', async () => {
  resetTempoBackendProbeCache();
  const backend = await probeTempoBackend({
    spawnFn: fakeSpawn(' T.. atempo          A->A       Adjust audio tempo.\n'),
  });
  assert.equal(backend, 'atempo');
});

test('probeTempoBackend returns null when neither filter nor the command is available', async () => {
  resetTempoBackendProbeCache();
  const backend = await probeTempoBackend({ spawnFn: fakeSpawn('', 1) });
  assert.equal(backend, null);
});

function fakeSpawnError(err) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => proc.emit('error', err));
    return proc;
  };
}

test('probeTempoBackend resolves to null (not a rejection) when the ffmpeg spawn itself fails', async () => {
  resetTempoBackendProbeCache();
  const backend = await probeTempoBackend({ spawnFn: fakeSpawnError(new Error('ENOENT')) });
  assert.equal(backend, null);
});

test('probeTempoBackend does not permanently cache a spawn failure — a later call can still detect the backend', async () => {
  resetTempoBackendProbeCache();
  const failed = await probeTempoBackend({ spawnFn: fakeSpawnError(new Error('spawn EAGAIN')) });
  assert.equal(failed, null);

  // A transient spawn error (unlike a genuine "no rubberband filter" build)
  // must not disable tempo matching for the rest of the process's life.
  const recovered = await probeTempoBackend({
    spawnFn: fakeSpawn(' T.. rubberband      A->A       ...\n'),
  });
  assert.equal(recovered, 'rubberband');
});

test('probeTempoBackend memoizes the result across calls', async () => {
  resetTempoBackendProbeCache();
  let calls = 0;
  const spawnFn = (...args) => {
    calls += 1;
    return fakeSpawn(' T.. rubberband      A->A       ...\n')(...args);
  };
  const first = await probeTempoBackend({ spawnFn });
  const second = await probeTempoBackend({ spawnFn });
  assert.equal(first, 'rubberband');
  assert.equal(second, 'rubberband');
  assert.equal(calls, 1, 'ffmpeg -filters should only be spawned once');
});

// --- compensateDurationSec --------------------------------------------------

test('compensateDurationSec divides native duration by the stretch ratio', () => {
  assert.ok(Math.abs(compensateDurationSec(200, 1.05) - 200 / 1.05) < 1e-9);
});

test('compensateDurationSec is a no-op for ratio 1 (unstretched)', () => {
  assert.equal(compensateDurationSec(200, 1), 200);
});

test('compensateDurationSec passes through null/invalid ratio and duration unchanged', () => {
  assert.equal(compensateDurationSec(200, null), 200);
  assert.equal(compensateDurationSec(200, 0), 200);
  assert.equal(compensateDurationSec(200, -1), 200);
  assert.equal(compensateDurationSec(null, 1.05), null);
});

// --- session tempo state ----------------------------------------------------

test('createSessionTempoState starts unstretched with no known BPM', () => {
  assert.deepEqual(createSessionTempoState(), { nativeBpm: null, playbackBpm: null, tempoRatio: 1 });
});

test('resetSessionTempo returns to native BPM with no stretch', () => {
  assert.deepEqual(resetSessionTempo(128), { nativeBpm: 128, playbackBpm: 128, tempoRatio: 1 });
  assert.deepEqual(resetSessionTempo(), { nativeBpm: null, playbackBpm: null, tempoRatio: 1 });
});

test('applySessionTempo stretches to the target BPM when in range', () => {
  const state = applySessionTempo(120, 122, { backend: 'rubberband' });
  assert.equal(state.nativeBpm, 120);
  assert.equal(state.playbackBpm, 122);
  assert.ok(Math.abs(state.tempoRatio - 122 / 120) < 1e-9);
});

test('applySessionTempo falls back to native (no stretch) when the target is out of range', () => {
  const state = applySessionTempo(100, 110, { backend: 'rubberband' }); // 10% > hard limit
  assert.deepEqual(state, { nativeBpm: 100, playbackBpm: 100, tempoRatio: 1 });
});

test('applySessionTempo falls back to native when nativeBpm is unknown', () => {
  const state = applySessionTempo(null, 122, { backend: 'rubberband' });
  assert.deepEqual(state, { nativeBpm: null, playbackBpm: null, tempoRatio: 1 });
});
