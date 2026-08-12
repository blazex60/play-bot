import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSilenceTrimFilter,
  SILENCE_TRIM_FILTER,
  SILENCE_TRIM_THRESHOLD_DB,
} from './silenceTrim.js';
import { trimSilence } from '../normalize.js';
import { probeDurationSec } from './duration.js';

function spawnBuffered(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `${cmd} exited ${code}`));
      else resolve();
    });
  });
}

test('buildSilenceTrimFilter includes leading and trailing trim', () => {
  const filter = buildSilenceTrimFilter({ thresholdDb: -45, keepSec: 0.03 });
  assert.match(filter, /silenceremove=/);
  assert.match(filter, /start_periods=1/);
  assert.match(filter, /stop_periods=-1/);
  assert.match(filter, /-45dB/);
  assert.match(filter, /start_silence=0\.03/);
  assert.equal(SILENCE_TRIM_THRESHOLD_DB, -50);
  assert.match(SILENCE_TRIM_FILTER, /stop_periods=-1/);
});

test('trimSilence removes leading and trailing padding from a synthetic file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'silence-trim-'));
  const src = path.join(dir, 'padded.wav');
  try {
    // 1s silence + 1s 440Hz tone + 1s silence ≈ 3s total.
    await spawnBuffered('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-af', 'adelay=1000|1000,apad=pad_dur=1',
      '-ac', '2',
      src,
    ]);

    const before = await probeDurationSec(src);
    assert.ok(before > 2.5 && before < 3.2, `expected ~3s before trim, got ${before}`);

    const trimmed = await trimSilence(src);
    assert.equal(trimmed, true);

    const after = await probeDurationSec(src);
    assert.ok(after < before - 1.2, `expected >1.2s removed, before=${before} after=${after}`);
    assert.ok(after > 0.8 && after < 1.4, `expected ~1s of tone left, got ${after}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trimSilence leaves original when output would be empty', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'silence-trim-empty-'));
  const src = path.join(dir, 'all-silence.wav');
  try {
    await spawnBuffered('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '1',
      src,
    ]);
    const before = await probeDurationSec(src);
    const trimmed = await trimSilence(src);
    assert.equal(trimmed, false);
    const after = await probeDurationSec(src);
    assert.ok(Math.abs(after - before) < 0.1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
