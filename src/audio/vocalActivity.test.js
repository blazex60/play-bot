import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVocalEnvelope, parseRmsLevels } from './vocalActivity.js';

test('parseRmsLevels extracts ffmpeg astats lines', () => {
  const levels = parseRmsLevels('foo RMS_level=-12.5\nRMS_level=-40.0\n');
  assert.deepEqual(levels, [-12.5, -40]);
});

test('classifyVocalEnvelope finds last vocal end on a sung outro', () => {
  const vocal = [-8, -8, -8, -45, -60, -60];
  const mix = [-6, -6, -6, -20, -30, -40];
  const result = classifyVocalEnvelope({
    vocalLevels: vocal,
    mixLevels: mix,
    tailStartSec: 100,
    frameSec: 0.1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'demucs');
  assert.ok(result.lastVocalEndSec > 100.2 && result.lastVocalEndSec < 100.5);
  assert.equal(result.vocalConfidence, 0.85);
});

test('classifyVocalEnvelope treats an instrumental tail as ending at window start', () => {
  const vocal = [-60, -62, -58, -61, -59];
  const mix = [-12, -12, -14, -16, -18];
  const result = classifyVocalEnvelope({
    vocalLevels: vocal,
    mixLevels: mix,
    tailStartSec: 80,
    frameSec: 0.1,
  });
  assert.equal(result.lastVocalEndSec, 80);
  assert.ok(result.vocalGaps.length >= 1);
});
