import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PcmSource } from './pcmSource.js';
import { BYTES_PER_SECOND } from './fade.js';
import { probeTempoBackend, resetTempoBackendProbeCache } from './tempo.js';

function fakeSpawn(cmds) {
  return (cmd, args) => {
    cmds.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    queueMicrotask(() => proc.emit('close', 0));
    return proc;
  };
}

test('createFileSource appends tempoFilter to the existing -af chain (measured)', () => {
  const cmds = [];
  PcmSource.createFileSource('/tmp/track.wav', {
    measured: { measured_I: -20, measured_TP: -1, measured_LRA: 5, measured_thresh: -30, offset: 1 },
    tempoFilter: 'rubberband=tempo=1.0167',
    spawnFn: fakeSpawn(cmds),
  });
  assert.equal(cmds.length, 1);
  const af = cmds[0].args[cmds[0].args.indexOf('-af') + 1];
  assert.match(af, /^loudnorm=.*,rubberband=tempo=1\.0167$/);
});

test('createFileSource appends tempoFilter after anull when unmeasured', () => {
  const cmds = [];
  PcmSource.createFileSource('/tmp/track.wav', {
    tempoFilter: 'atempo=1.0300',
    spawnFn: fakeSpawn(cmds),
  });
  const af = cmds[0].args[cmds[0].args.indexOf('-af') + 1];
  assert.equal(af, 'anull,atempo=1.0300');
});

test('createFileSource omits tempoFilter entirely when not provided (existing behavior unchanged)', () => {
  const cmds = [];
  PcmSource.createFileSource('/tmp/track.wav', { spawnFn: fakeSpawn(cmds) });
  const af = cmds[0].args[cmds[0].args.indexOf('-af') + 1];
  assert.equal(af, 'anull');
});

// --- Real ffmpeg: rubberband actually stretches output duration ------------

function ffmpegHasFilter(name) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-filters']);
  return new RegExp(`\\b${name}\\b`).test(result.stdout?.toString() ?? '');
}

const HAS_RUBBERBAND = ffmpegHasFilter('rubberband');

function synthesizeTone(destPath, { durationSec = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationSec}`,
      destPath,
    ]);
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

function drainAll(source) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const pump = () => {
      let chunk;
      while ((chunk = source.read(65536))) {
        total += chunk.length;
      }
      if (source.ended) {
        if (source.error) reject(source.error);
        else resolve(total);
      }
    };
    source.on('data', pump);
    source.on('end', pump);
    source.on('error', reject);
    pump();
  });
}

test(
  'rubberband tempoFilter halves output byte length at tempo=2.0 (real ffmpeg)',
  { skip: !HAS_RUBBERBAND && 'ffmpeg built without librubberband' },
  async () => {
    resetTempoBackendProbeCache();
    const backend = await probeTempoBackend();
    if (backend !== 'rubberband') {
      // Filter is listed in -filters but unusable at runtime on this host; skip.
      return;
    }

    const dir = await mkdtemp(path.join(os.tmpdir(), 'pcmsource-tempo-'));
    const src = path.join(dir, 'tone.wav');
    try {
      await synthesizeTone(src, { durationSec: 4 });

      const baseline = PcmSource.createFileSource(src, {});
      const baselineBytes = await drainAll(baseline);

      const stretched = PcmSource.createFileSource(src, { tempoFilter: 'rubberband=tempo=2.0' });
      const stretchedBytes = await drainAll(stretched);

      const baselineSec = baselineBytes / BYTES_PER_SECOND;
      const stretchedSec = stretchedBytes / BYTES_PER_SECOND;
      assert.ok(baselineSec > 3.5 && baselineSec < 4.5, `expected ~4s baseline, got ${baselineSec}`);
      assert.ok(
        Math.abs(stretchedSec - baselineSec / 2) < 0.3,
        `expected ~${baselineSec / 2}s stretched, got ${stretchedSec}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
