import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_UNDERRUN_MS } from './config.js';

test('MAX_UNDERRUN_MS is the mixer continuous-silence guard', () => {
  assert.equal(MAX_UNDERRUN_MS, 8000);
});
