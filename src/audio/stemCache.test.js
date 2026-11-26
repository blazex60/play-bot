import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rm, readFile, readdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import {
  STEM_CACHE_DIR,
  getCachedStems,
  separateTrackStems,
  pruneStemCache,
  cleanupStaleStemStaging,
  isStemSeparationAvailable,
  resetStemCircuitForTest,
} from './stemCache.js';
import { currentDemucsDevice, resetDemucsDeviceForTest } from './demucsDevice.js';
import { DEMUCS_MODEL } from './vocalActivity.js';
import { STEM_HEAD_WINDOW_SEC, STEM_TAIL_WINDOW_SEC } from './stemConfig.js';

function uniqueVideoId(label) {
  return `stem-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function cleanup(videoId) {
  await rm(path.join(STEM_CACHE_DIR, videoId), { recursive: true, force: true }).catch(() => {});
}

/**
 * Mirrors vocalActivity.test.js's fakeVocalSpawn shape (an EventEmitter-
 * based fake child process), but ALSO writes real files at the paths
 * separateTrackStems() expects to find them at afterward (input.wav from
 * the ffmpeg cut step, then vocals.wav/no_vocals.wav under
 * <tmpRoot>/<DEMUCS_MODEL>/input/ from the Demucs step) — stemCache.js
 * checks file existence via access(), so a fake with no real I/O side
 * effect can't stand in for it the way vocalActivity.js's stderr-only fake
 * can for a read-only ffmpeg -f null pass.
 */
function fakeSpawn({ cutFails = false, demucsFails = false, cmds = [], durationSec = 100, cudaBroken = false } = {}) {
  return (cmd, args = []) => {
    cmds.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(async () => {
      try {
        if (cmd === 'ffprobe') {
          proc.stdout.emit('data', `${durationSec ?? 'N/A'}\n`);
          proc.emit('close', 0);
          return;
        }
        if (cmd === 'ffmpeg') {
          if (cutFails) {
            proc.emit('close', 1);
            return;
          }
          const outPath = args[args.length - 1];
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, Buffer.from('fake-input-wav'));
          proc.emit('close', 0);
          return;
        }
        // Anything else stands in for whatever resolveDemucsBin() resolved to.
        if (cudaBroken && args[args.indexOf('-d') + 1] === 'cuda') {
          proc.stderr.emit('data', 'torch.AcceleratorError: CUDA error: no kernel image is available for execution on the device\n');
          proc.emit('close', 1);
          return;
        }
        if (demucsFails) {
          proc.emit('close', 1);
          return;
        }
        // Demucs writes <out>/<model>/<input basename>/{vocals,no_vocals}.wav
        // for every input file it was given (after the -o <dir> pair).
        const oIndex = args.indexOf('-o');
        const outRoot = args[oIndex + 1];
        for (const input of args.slice(oIndex + 2)) {
          const stemDir = path.join(outRoot, DEMUCS_MODEL, path.basename(input, '.wav'));
          await mkdir(stemDir, { recursive: true });
          await writeFile(path.join(stemDir, 'vocals.wav'), Buffer.from(`fake-vocal-${path.basename(input, '.wav')}`));
          await writeFile(path.join(stemDir, 'no_vocals.wav'), Buffer.from(`fake-instrumental-${path.basename(input, '.wav')}`));
        }
        proc.emit('close', 0);
      } catch (err) {
        proc.emit('error', err);
      }
    });
    return proc;
  };
}

test('getCachedStems returns null when nothing has been separated for this videoId', async () => {
  const videoId = uniqueVideoId('miss');
  assert.equal(await getCachedStems(videoId), null);
});

test('separateTrackStems writes vocal/instrumental into the persistent cache and getCachedStems then finds them', async () => {
  const videoId = uniqueVideoId('hit');
  try {
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn() });
    assert.ok(result);
    assert.ok(result.vocalPath.endsWith('vocal.wav'));
    assert.ok(result.instrumentalPath.endsWith('instrumental.wav'));
    assert.equal((await readFile(result.vocalPath)).toString(), 'fake-vocal-input');
    assert.equal((await readFile(result.instrumentalPath)).toString(), 'fake-instrumental-input');
    assert.deepEqual(result.windows.map((w) => [w.name, w.startSec, w.endSec]), [['full', 0, 100]]);

    const cached = await getCachedStems(videoId);
    assert.deepEqual(cached, result);
  } finally {
    await cleanup(videoId);
  }
});

test('getCachedStems invalidates an entry whose sidecar records a different Demucs model', async () => {
  const videoId = uniqueVideoId('stale-model');
  try {
    await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn() });
    const metaPath = path.join(STEM_CACHE_DIR, videoId, 'meta.json');
    await writeFile(metaPath, JSON.stringify({ demucsModel: 'some-other-model', separatedAt: Date.now() }));
    assert.equal(await getCachedStems(videoId), null);
  } finally {
    await cleanup(videoId);
  }
});

test('separateTrackStems returns null and does not throw when the ffmpeg cut step fails', async () => {
  const videoId = uniqueVideoId('cut-fail');
  try {
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, {
      spawnFn: fakeSpawn({ cutFails: true }),
    });
    assert.equal(result, null);
    assert.equal(await getCachedStems(videoId), null);
  } finally {
    await cleanup(videoId);
  }
});

test('separateTrackStems returns null and does not throw when the Demucs step fails', async () => {
  const videoId = uniqueVideoId('demucs-fail');
  try {
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, {
      spawnFn: fakeSpawn({ demucsFails: true }),
    });
    assert.equal(result, null);
    assert.equal(await getCachedStems(videoId), null);
  } finally {
    await cleanup(videoId);
  }
});

test('separateTrackStems dedupes concurrent calls for the same videoId (only one separation runs)', async () => {
  const videoId = uniqueVideoId('concurrent');
  try {
    const cmds = [];
    const spawnFn = fakeSpawn({ cmds });
    const [a, b] = await Promise.all([
      separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn }),
      separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn }),
    ]);
    assert.deepEqual(a, b);
    // ffprobe + ffmpeg cut + demucs = 3 spawns for ONE separation; a
    // duplicate run would double this to 6.
    assert.equal(cmds.length, 3, `expected exactly one separation's worth of spawns, got ${cmds.length}`);
  } finally {
    await cleanup(videoId);
  }
});

test('separateTrackStems stages its working directory under STEM_CACHE_DIR, not os.tmpdir()', async () => {
  // Codex: the eventual rename() of Demucs' output into the persistent
  // cache must land on the SAME filesystem as its source, or it fails with
  // EXDEV — in the production container, STEM_CACHE_DIR (data/, bind-
  // mounted) and os.tmpdir() (the container's own /tmp) are different
  // filesystems. Staging under STEM_CACHE_DIR itself keeps the rename local.
  const videoId = uniqueVideoId('staging-dir');
  try {
    const cmds = [];
    await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn({ cmds }) });
    const ffmpegCall = cmds.find((c) => c.cmd === 'ffmpeg');
    const inputWav = ffmpegCall.args[ffmpegCall.args.length - 1];
    assert.ok(inputWav.startsWith(STEM_CACHE_DIR),
      `expected the ffmpeg cut step's working file (${inputWav}) to be staged under STEM_CACHE_DIR`);
  } finally {
    await cleanup(videoId);
  }
});

test('separateTrackStems re-checks the cache and skips re-running Demucs when already cached', async () => {
  const videoId = uniqueVideoId('already-cached');
  try {
    await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn() });
    const cmds = [];
    const second = await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn({ cmds }) });
    assert.ok(second);
    assert.equal(cmds.length, 0, 'expected zero spawns on a second call once already cached');
  } finally {
    await cleanup(videoId);
  }
});

async function entryTotalBytes(videoId) {
  const dir = path.join(STEM_CACHE_DIR, videoId);
  let total = 0;
  for (const file of ['vocal.wav', 'instrumental.wav', 'meta.json']) {
    total += (await stat(path.join(dir, file))).size;
  }
  return total;
}

/**
 * STEM_CACHE_DIR is the same persistent, machine-shared directory a real
 * Bot process caches into (data/stems — see stemCache.js's module docstring).
 * A dev machine running this suite alongside a populated real cache must not
 * have its unrelated entries swept up by this test's tight maxBytes cap —
 * baseline against whatever was already there before this test's own writes.
 */
async function currentTotalBytes() {
  let entries;
  try {
    entries = await readdir(STEM_CACHE_DIR, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      total += await entryTotalBytes(entry.name);
    } catch {
      // Racing with another writer/pruner — skip, best-effort baseline only.
    }
  }
  return total;
}

test('pruneStemCache evicts the oldest entries once the total size exceeds maxBytes', async () => {
  const oldId = uniqueVideoId('prune-old');
  const newId = uniqueVideoId('prune-new');
  try {
    const baseline = await currentTotalBytes();
    await separateTrackStems('/tmp/fake-track-source', oldId, { spawnFn: fakeSpawn() });
    // Backdate the old entry's files so mtime-based LRU picks it first.
    const oldDir = path.join(STEM_CACHE_DIR, oldId);
    const past = new Date(Date.now() - 60_000);
    for (const file of ['vocal.wav', 'instrumental.wav', 'meta.json']) {
      await utimes(path.join(oldDir, file), past, past);
    }
    await separateTrackStems('/tmp/fake-track-source', newId, { spawnFn: fakeSpawn() });

    const newSize = await entryTotalBytes(newId);
    // Cap tight enough that only the newer entry (plus whatever pre-existed
    // before this test ran) survives — big enough to hold the new entry on
    // top of the baseline, too small to also hold the old test entry.
    await pruneStemCache({ maxBytes: baseline + newSize });

    assert.equal(await getCachedStems(oldId), null, 'expected the older entry to be evicted');
    assert.ok(await getCachedStems(newId), 'expected the newer entry to survive');
  } finally {
    await cleanup(oldId);
    await cleanup(newId);
  }
});

test('pruneStemCache does nothing when the total size is already under maxBytes', async () => {
  const videoId = uniqueVideoId('prune-noop');
  try {
    await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn() });
    await pruneStemCache({ maxBytes: Number.MAX_SAFE_INTEGER });
    assert.ok(await getCachedStems(videoId), 'expected the entry to survive a prune well under the cap');
  } finally {
    await cleanup(videoId);
  }
});

test('cleanupStaleStemStaging removes an orphaned .stemsep-* directory left by a killed process', async () => {
  // Codex: runSeparation()'s own finally block removes its jobTmpRoot on
  // every normal exit, but a killed process or a recreated container skips
  // that finally entirely — the staging dir (and its partial WAVs) is then
  // orphaned forever, since pruneStemCache() deliberately skips anything
  // that isn't a valid videoId shape (so it never touches an in-progress
  // job's staging dir). Only cleanupStaleStemStaging(), called once at
  // startup, ever reclaims these.
  await mkdir(STEM_CACHE_DIR, { recursive: true });
  const staleDir = path.join(STEM_CACHE_DIR, `.stemsep-orphan-${Date.now()}`);
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, 'input.wav'), 'partial-orphaned-data');
  try {
    await cleanupStaleStemStaging();
    await assert.rejects(() => stat(staleDir), 'expected the orphaned staging directory to be removed');
  } finally {
    await rm(staleDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('cleanupStaleStemStaging leaves real videoId cache entries untouched', async () => {
  const videoId = uniqueVideoId('staging-cleanup-noop');
  try {
    await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn() });
    await cleanupStaleStemStaging();
    assert.ok(await getCachedStems(videoId), 'expected a real cache entry to survive staging cleanup');
  } finally {
    await cleanup(videoId);
  }
});

test('separateTrackStems separates only the head and tail windows of a long track, in one Demucs run', async () => {
  resetStemCircuitForTest();
  const videoId = uniqueVideoId('windows');
  try {
    const cmds = [];
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn({ cmds, durationSec: 300 }) });
    assert.deepEqual(result.windows.map((w) => [w.name, w.startSec, w.endSec]), [
      ['head', 0, STEM_HEAD_WINDOW_SEC],
      ['tail', 300 - STEM_TAIL_WINDOW_SEC, 300],
    ]);
    assert.equal(result.vocalPath, undefined, 'a windowed entry must not pose as a whole-track pair');
    const cuts = cmds.filter((c) => c.cmd === 'ffmpeg');
    assert.equal(cuts.length, 2);
    assert.deepEqual(cuts[1].args.slice(cuts[1].args.indexOf('-ss'), cuts[1].args.indexOf('-ss') + 4), ['-ss', '225.000', '-t', '75.000']);
    const demucsRuns = cmds.filter((c) => c.cmd !== 'ffmpeg' && c.cmd !== 'ffprobe');
    assert.equal(demucsRuns.length, 1, 'both windows go through one Demucs process');
    assert.equal((await readFile(result.windows[1].vocalPath)).toString(), 'fake-vocal-tail');
    assert.deepEqual(await getCachedStems(videoId), result);
  } finally {
    await cleanup(videoId);
  }
});

test('getCachedStems still reads a v1 (whole-track, no windows) entry', async () => {
  const videoId = uniqueVideoId('v1');
  const dir = path.join(STEM_CACHE_DIR, videoId);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'vocal.wav'), 'v');
    await writeFile(path.join(dir, 'instrumental.wav'), 'i');
    await writeFile(path.join(dir, 'meta.json'), JSON.stringify({ demucsModel: DEMUCS_MODEL, separatedAt: Date.now() }));
    const cached = await getCachedStems(videoId);
    assert.equal(cached.vocalPath, path.join(dir, 'vocal.wav'));
    assert.deepEqual(cached.windows.map((w) => [w.name, w.startSec, w.endSec]), [['full', 0, null]]);
  } finally {
    await cleanup(videoId);
  }
});

test('STEM_SEPARATION_ENABLED=false skips separation without spawning anything', async () => {
  const videoId = uniqueVideoId('disabled');
  const cmds = [];
  const result = await separateTrackStems('/tmp/fake-track-source', videoId, {
    spawnFn: fakeSpawn({ cmds }),
    env: { STEM_SEPARATION_ENABLED: 'false' },
  });
  assert.equal(result, null);
  assert.equal(cmds.length, 0);
  assert.equal(isStemSeparationAvailable({ env: { STEM_SEPARATION_ENABLED: 'false' } }), false);
});

test('consecutive failures open the circuit breaker, which then skips new separations until the cooldown ends', async () => {
  resetStemCircuitForTest();
  const env = { STEM_CIRCUIT_FAILURES: '2', STEM_CIRCUIT_COOLDOWN_MS: '60000' };
  const ids = [uniqueVideoId('cb1'), uniqueVideoId('cb2'), uniqueVideoId('cb3')];
  try {
    for (const id of ids.slice(0, 2)) {
      assert.equal(await separateTrackStems('/tmp/fake-track-source', id, { spawnFn: fakeSpawn({ demucsFails: true }), env }), null);
    }
    assert.equal(isStemSeparationAvailable({ env }), false, 'two failures in a row open the breaker');
    assert.equal(isStemSeparationAvailable({ env, now: Date.now() + 61_000 }), true, 'and it closes after the cooldown');
    const cmds = [];
    assert.equal(await separateTrackStems('/tmp/fake-track-source', ids[2], { spawnFn: fakeSpawn({ cmds }), env }), null);
    assert.equal(cmds.length, 0, 'no work starts while the breaker is open');
  } finally {
    resetStemCircuitForTest();
    for (const id of ids) await cleanup(id);
  }
});

test('a success resets the consecutive-failure count', async () => {
  resetStemCircuitForTest();
  const env = { STEM_CIRCUIT_FAILURES: '2' };
  const ids = [uniqueVideoId('rs1'), uniqueVideoId('rs2'), uniqueVideoId('rs3')];
  try {
    await separateTrackStems('/tmp/fake-track-source', ids[0], { spawnFn: fakeSpawn({ demucsFails: true }), env });
    assert.ok(await separateTrackStems('/tmp/fake-track-source', ids[1], { spawnFn: fakeSpawn(), env }));
    await separateTrackStems('/tmp/fake-track-source', ids[2], { spawnFn: fakeSpawn({ demucsFails: true }), env });
    assert.equal(isStemSeparationAvailable({ env }), true);
  } finally {
    resetStemCircuitForTest();
    for (const id of ids) await cleanup(id);
  }
});

test('separateTrackStems skips (without counting a failure) when the track length is unknown', async () => {
  resetStemCircuitForTest();
  const env = { STEM_CIRCUIT_FAILURES: '1' };
  const videoId = uniqueVideoId('no-duration');
  const cmds = [];
  try {
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, { spawnFn: fakeSpawn({ cmds, durationSec: null }), env });
    assert.equal(result, null);
    assert.deepEqual(cmds.map((c) => c.cmd), ['ffprobe'], 'no cut and no Demucs run without a length');
    assert.equal(isStemSeparationAvailable({ env }), true, 'a skip is not a failure');
  } finally {
    resetStemCircuitForTest();
    await cleanup(videoId);
  }
});

test('after the cooldown the breaker is half-open: one more failure reopens it', async () => {
  resetStemCircuitForTest();
  const env = { STEM_CIRCUIT_FAILURES: '3', STEM_CIRCUIT_COOLDOWN_MS: '0' };
  const ids = [1, 2, 3, 4].map((i) => uniqueVideoId(`ho${i}`));
  try {
    for (const id of ids.slice(0, 3)) {
      await separateTrackStems('/tmp/fake-track-source', id, { spawnFn: fakeSpawn({ demucsFails: true }), env });
    }
    // Cooldown 0 → closed again right away, but the next single failure
    // must reopen it rather than needing three more.
    const reopenEnv = { ...env, STEM_CIRCUIT_COOLDOWN_MS: '60000' };
    await separateTrackStems('/tmp/fake-track-source', ids[3], { spawnFn: fakeSpawn({ demucsFails: true }), env: reopenEnv });
    assert.equal(isStemSeparationAvailable({ env: reopenEnv }), false);
  } finally {
    resetStemCircuitForTest();
    for (const id of ids) await cleanup(id);
  }
});

test('on the GPU the whole track is separated in one Demucs run with -d cuda', async () => {
  resetStemCircuitForTest();
  resetDemucsDeviceForTest();
  const videoId = uniqueVideoId('gpu-full');
  try {
    const cmds = [];
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, {
      spawnFn: fakeSpawn({ cmds, durationSec: 300 }),
      deviceFn: async () => 'cuda',
    });
    assert.deepEqual(result.windows.map((w) => [w.name, w.startSec, w.endSec]), [['full', 0, 300]]);
    const demucs = cmds.find((c) => c.args.includes('--two-stems=vocals'));
    assert.equal(demucs.args[demucs.args.indexOf('-d') + 1], 'cuda');
  } finally {
    await cleanup(videoId);
  }
});

test('a CUDA failure retries the job once on CPU (head/tail windows) and degrades later runs to CPU', async () => {
  resetStemCircuitForTest();
  resetDemucsDeviceForTest();
  const videoId = uniqueVideoId('gpu-fallback');
  try {
    const cmds = [];
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, {
      spawnFn: fakeSpawn({ cmds, durationSec: 300, cudaBroken: true }),
      deviceFn: async () => 'cuda',
    });
    assert.ok(result, 'the CPU retry succeeds');
    assert.deepEqual(result.windows.map((w) => w.name), ['head', 'tail']);
    const devices = cmds.filter((c) => c.args.includes('--two-stems=vocals')).map((c) => c.args[c.args.indexOf('-d') + 1]);
    assert.deepEqual(devices, ['cuda', 'cpu']);
    assert.equal(currentDemucsDevice({ DEMUCS_DEVICE: 'cuda' }), 'cpu');
  } finally {
    resetDemucsDeviceForTest();
    await cleanup(videoId);
  }
});

test('a non-CUDA Demucs failure on the GPU is not retried on CPU', async () => {
  resetStemCircuitForTest();
  resetDemucsDeviceForTest();
  const videoId = uniqueVideoId('gpu-badinput');
  try {
    const cmds = [];
    const result = await separateTrackStems('/tmp/fake-track-source', videoId, {
      spawnFn: fakeSpawn({ cmds, durationSec: 300, demucsFails: true }),
      deviceFn: async () => 'cuda',
    });
    assert.equal(result, null);
    assert.equal(cmds.filter((c) => c.args.includes('--two-stems=vocals')).length, 1);
    assert.equal(currentDemucsDevice({ DEMUCS_DEVICE: 'cuda' }), 'cuda', 'not degraded');
  } finally {
    resetStemCircuitForTest();
    resetDemucsDeviceForTest();
    await cleanup(videoId);
  }
});
