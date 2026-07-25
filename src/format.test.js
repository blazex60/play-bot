import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtDuration, LOOP_LABELS } from './format.js'
import { LoopMode } from './queue.js'

test('fmtDuration: null/undefined duration is 不明', () => {
  assert.equal(fmtDuration(null), '不明')
  assert.equal(fmtDuration(undefined), '不明')
})

test('fmtDuration: under an hour omits the hour component', () => {
  assert.equal(fmtDuration(0), '0:00')
  assert.equal(fmtDuration(65), '1:05')
  assert.equal(fmtDuration(3599), '59:59')
})

test('fmtDuration: an hour or more includes the hour component, zero-padded', () => {
  assert.equal(fmtDuration(3600), '1:00:00')
  assert.equal(fmtDuration(3665), '1:01:05')
})

test('LOOP_LABELS has an entry for every LoopMode value', () => {
  for (const mode of Object.values(LoopMode)) {
    assert.equal(typeof LOOP_LABELS[mode], 'string')
  }
  assert.equal(Object.keys(LOOP_LABELS).length, Object.values(LoopMode).length)
})
