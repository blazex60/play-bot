import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile, rm, readFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import {
  STEM_CACHE_DIR,
  getCachedStems,
  separateTrackStems,
  pruneStemCache,
} from './stemCache.js';
import { DEMUCS_MODEL } from './vocalActivity.js';

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
function fakeSpawn({ cutFails = false, demucsFails = false, cmds = [] } = {}) {
  return (cmd, args = []) => {
    cmds.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(async () => {
      try {
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
        if (demucsFails) {
          proc.emit('close', 1);
          return;
        }
        const oIndex = args.indexOf('-o');
        const outRoot = args[oIndex + 1];
        const stemDir = path.join(outRoot, DEMUCS_MODEL, 'input');
        await mkdir(stemDir, { recursive: true });
        await writeFile(path.join(stemDir, 'vocals.wav'), Buffer.from('fake-vocal'));
        await writeFile(path.join(stemDir, 'no_vocals.wav'), Buffer.from('fake-instrumental'));
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
    assert.equal((await readFile(result.vocalPath)).toString(), 'fake-vocal');
    assert.equal((await readFile(result.instrumentalPath)).toString(), 'fake-instrumental');

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
    // ffmpeg cut + demucs = 2 spawns for ONE separation; a duplicate run
    // would double this to 4.
    assert.equal(cmds.length, 2, `expected exactly one separation's worth of spawns, got ${cmds.length}`);
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

test('pruneStemCache evicts the oldest entries once the total size exceeds maxBytes', async () => {
  const oldId = uniqueVideoId('prune-old');
  const newId = uniqueVideoId('prune-new');
  try {
    await separateTrackStems('/tmp/fake-track-source', oldId, { spawnFn: fakeSpawn() });
    // Backdate the old entry's files so mtime-based LRU picks it first.
    const oldDir = path.join(STEM_CACHE_DIR, oldId);
    const past = new Date(Date.now() - 60_000);
    for (const file of ['vocal.wav', 'instrumental.wav', 'meta.json']) {
      await utimes(path.join(oldDir, file), past, past);
    }
    await separateTrackStems('/tmp/fake-track-source', newId, { spawnFn: fakeSpawn() });

    const newSize = await entryTotalBytes(newId);
    // Cap tight enough that only the newer entry survives — big enough to
    // hold the new entry, too small to hold both.
    await pruneStemCache({ maxBytes: newSize });

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
