import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_NORMALIZE_DURATION_SEC,
  NormalizeError,
  isNormalizeDurationAllowed,
  parseLoudnormJson,
} from './normalize.js'

test('parseLoudnormJson: ffmpeg stderr末尾のJSONをパースする', () => {
  const measured = parseLoudnormJson(`
    ffmpeg version ...
    [Parsed_loudnorm_0 @ 0x123] 
    {
      "input_i" : "-23.45",
      "input_tp" : "-2.34",
      "input_lra" : "9.80",
      "input_thresh" : "-34.56",
      "output_i" : "-16.01",
      "target_offset" : "-0.12"
    }
  `)

  assert.deepEqual(measured, {
    measured_I: '-23.45',
    measured_TP: '-2.34',
    measured_LRA: '9.80',
    measured_thresh: '-34.56',
    offset: '-0.12',
  })
})

test('parseLoudnormJson: measured_*形式も受け付ける', () => {
  const measured = parseLoudnormJson(`
    {"measured_I":"-20","measured_TP":"-1","measured_LRA":"7","measured_thresh":"-30","offset":"0.5"}
  `)

  assert.deepEqual(measured, {
    measured_I: '-20',
    measured_TP: '-1',
    measured_LRA: '7',
    measured_thresh: '-30',
    offset: '0.5',
  })
})

test('parseLoudnormJson: 不正JSONは例外', () => {
  assert.throws(
    () => parseLoudnormJson('ffmpeg log\n{not json}\n'),
    NormalizeError
  )
})

test('parseLoudnormJson: 必須フィールド欠損は例外', () => {
  assert.throws(
    () => parseLoudnormJson('{"input_i":"-16"}'),
    NormalizeError
  )
})

test('isNormalizeDurationAllowed: 30分以下または不明なら許可する', () => {
  assert.equal(isNormalizeDurationAllowed({ duration: MAX_NORMALIZE_DURATION_SEC }), true)
  assert.equal(isNormalizeDurationAllowed({ duration: null }), true)
  assert.equal(isNormalizeDurationAllowed({}), true)
})

test('isNormalizeDurationAllowed: 30分超は拒否する', () => {
  assert.equal(isNormalizeDurationAllowed({ duration: MAX_NORMALIZE_DURATION_SEC + 1 }), false)
})
