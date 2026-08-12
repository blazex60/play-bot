import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSilenceTrimFilter,
  buildAtrimFilter,
  parseSilenceDetectLog,
  resolveEdgeTrimWindow,
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
      else resolve({ stderr });
    });
  });
}

test('buildSilenceTrimFilter is leading-only (no areverse / stop_periods)', () => {
  const filter = buildSilenceTrimFilter({ thresholdDb: -45, keepSec: 0.03 });
  assert.match(filter, /silenceremove=/);
  assert.match(filter, /start_periods=1/);
  assert.doesNotMatch(filter, /areverse/);
  assert.doesNotMatch(filter, /stop_periods=/);
  assert.match(filter, /-45dB/);
  assert.match(filter, /start_silence=0\.03/);
  assert.equal(SILENCE_TRIM_THRESHOLD_DB, -50);
  assert.doesNotMatch(SILENCE_TRIM_FILTER, /areverse/);
});

test('parseSilenceDetectLog extracts starts and ends', () => {
  const log = [
    '[silencedetect @ 0x1] silence_start: 0.01',
    '[silencedetect @ 0x1] silence_end: 1.02 | silence_duration: 1.01',
    '[silencedetect @ 0x1] silence_start: 5.5',
  ].join('\n');
  const { starts, ends } = parseSilenceDetectLog(log);
  assert.deepEqual(starts, [0.01, 5.5]);
  assert.deepEqual(ends, [1.02]);
});

test('resolveEdgeTrimWindow trims edge pads and keeps mid silence', () => {
  const mid = resolveEdgeTrimWindow({
    durationSec: 1.8,
    silenceStarts: [0.5],
    silenceEnds: [1.3],
    keepSec: 0.02,
  });
  assert.equal(mid.changed, false);

  const padded = resolveEdgeTrimWindow({
    durationSec: 3,
    silenceStarts: [0, 2],
    silenceEnds: [1],
    keepSec: 0.02,
  });
  assert.equal(padded.changed, true);
  assert.ok(padded.startSec > 0.9 && padded.startSec < 1.05);
  assert.ok(padded.endSec > 1.95 && padded.endSec < 2.1);

  const filter = buildAtrimFilter(padded);
  assert.match(filter, /atrim=start=/);
  assert.match(filter, /asetpts=PTS-STARTPTS/);
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

test('trimSilence preserves mid-track silence (edge detect only)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'silence-trim-mid-'));
  const src = path.join(dir, 'mid-silence.wav');
  try {
    // 0.5s tone + 0.8s silence + 0.5s tone ≈ 1.8s; only edges should trim.
    await spawnBuffered('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.5',
      '-filter_complex',
      '[1]atrim=0:0.8[s];[0][s][2]concat=n=3:v=0:a=1[a]',
      '-map', '[a]',
      '-ac', '2',
      src,
    ]);

    const before = await probeDurationSec(src);
    assert.ok(before > 1.6 && before < 2.0, `expected ~1.8s before, got ${before}`);

    const trimmed = await trimSilence(src);
    // No edge pads → unchanged (or tiny keep pads only).
    assert.equal(trimmed, false);

    const after = await probeDurationSec(src);
    assert.ok(after > 1.5, `mid silence was removed: before=${before} after=${after}`);
    assert.ok(Math.abs(after - before) < 0.1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trimSilence skips when source duration probe fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'silence-trim-unknown-'));
  const src = path.join(dir, 'tone.wav');
  try {
    await spawnBuffered('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-ac', '2',
      src,
    ]);
    const before = await probeDurationSec(src);
    const trimmed = await trimSilence(src, {
      probeDurationFn: async () => null,
    });
    assert.equal(trimmed, false);
    const after = await probeDurationSec(src);
    assert.ok(Math.abs(after - before) < 0.1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
