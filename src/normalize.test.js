import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import {
  MAX_NORMALIZE_DURATION_SEC,
  NormalizeError,
  isNormalizeDurationAllowed,
  parseLoudnormJson,
  stageTempFileCopy,
  cleanupTempFile,
  TEMP_DIR,
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

test('isNormalizeDurationAllowed: 尺が分かる30分以下なら許可する', () => {
  assert.equal(isNormalizeDurationAllowed({ duration: MAX_NORMALIZE_DURATION_SEC }), true)
  assert.equal(isNormalizeDurationAllowed({ duration: 1 }), true)
})

test('isNormalizeDurationAllowed: 尺不明や30分超は拒否する', () => {
  assert.equal(isNormalizeDurationAllowed({ duration: null }), false)
  assert.equal(isNormalizeDurationAllowed({}), false)
  assert.equal(isNormalizeDurationAllowed({ duration: Number.NaN }), false)
  assert.equal(isNormalizeDurationAllowed({ duration: Number.POSITIVE_INFINITY }), false)
  assert.equal(isNormalizeDurationAllowed({ duration: MAX_NORMALIZE_DURATION_SEC + 1 }), false)
})

test('stageTempFileCopy: 独立したコピーを作成し、元ファイル削除後も内容が残る（Codex, PR #39）', async () => {
  await mkdir(TEMP_DIR, { recursive: true })
  const original = `${TEMP_DIR}/stage-test-original-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await writeFile(original, 'hello stem separation')
  let staged
  try {
    staged = await stageTempFileCopy(original)
    assert.notEqual(staged, original, 'expected a distinct path, not the original')

    // The whole point: deleting the original must not affect the staged
    // copy — that decoupling is what protects a queued stem-separation job
    // from unrelated cleanup deleting the source file out from under it.
    await cleanupTempFile(original)
    await assert.rejects(() => access(original), 'expected the original to actually be gone')

    const content = await readFile(staged, 'utf8')
    assert.equal(content, 'hello stem separation')
  } finally {
    if (staged) await cleanupTempFile(staged)
    await rm(original, { force: true })
  }
})
