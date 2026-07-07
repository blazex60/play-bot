import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  configureSettingsPathForTest,
  getGuildSettings,
  loadSettings,
  setNormalize,
} from './settings.js'

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-settings-test-'))
  const filePath = join(dir, 'data', 'guild-settings.json')
  configureSettingsPathForTest(filePath)
  try {
    await fn({ dir, filePath })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('settings: missing file defaults normalize to false', async () => {
  await withTempSettings(async ({ filePath }) => {
    loadSettings()
    assert.equal(existsSync(filePath), false)
    assert.deepEqual(getGuildSettings('guild-1'), { normalize: false })
  })
})

test('settings: setNormalize persists and loadSettings restores values', async () => {
  await withTempSettings(async ({ filePath }) => {
    await setNormalize('guild-1', true)
    assert.deepEqual(getGuildSettings('guild-1'), { normalize: true })

    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.deepEqual(getGuildSettings('guild-1'), { normalize: true })
  })
})

test('settings: atomic write leaves a valid JSON settings file', async () => {
  await withTempSettings(async ({ dir, filePath }) => {
    await setNormalize('guild-1', true)
    await setNormalize('guild-2', false)

    const raw = await readFile(filePath, 'utf8')
    assert.deepEqual(JSON.parse(raw), {
      'guild-1': { normalize: true },
      'guild-2': { normalize: false },
    })

    const files = await readdir(join(dir, 'data'))
    assert.deepEqual(files, ['guild-settings.json'])
  })
})
