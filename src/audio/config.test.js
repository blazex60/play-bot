import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMixerEnabled } from './config.js';

test('isMixerEnabled returns true only when MIXER_ENABLED is "true"', () => {
  const original = process.env.MIXER_ENABLED;
  try {
    delete process.env.MIXER_ENABLED;
    assert.equal(isMixerEnabled(), false);

    process.env.MIXER_ENABLED = 'false';
    assert.equal(isMixerEnabled(), false);

    process.env.MIXER_ENABLED = 'true';
    assert.equal(isMixerEnabled(), true);
  } finally {
    if (original === undefined) {
      delete process.env.MIXER_ENABLED;
    } else {
      process.env.MIXER_ENABLED = original;
    }
  }
});
