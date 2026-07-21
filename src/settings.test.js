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
  setAutoplayMode,
  setNormalize,
  setPersonalize,
  setAutoNotify,
  setDefaultCommandPermission,
  setUserCommandPermission,
  resolveCommandPermission,
  setCommandVisibility,
  getCommandVisibilitySettings,
} from './settings.js'

const DEFAULT_RECORD = {
  normalize: false,
  autoplayMode: 'off',
  personalize: false,
  autoNotify: false,
  commandPermissions: { defaults: {}, overrides: {} },
  commandVisibility: {},
}

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

test('settings: missing file defaults normalize/autoplayMode/personalize', async () => {
  await withTempSettings(async ({ filePath }) => {
    loadSettings()
    assert.equal(existsSync(filePath), false)
    assert.deepEqual(getGuildSettings('guild-1'), DEFAULT_RECORD)
  })
})

test('settings: setNormalize persists and loadSettings restores values', async () => {
  await withTempSettings(async ({ filePath }) => {
    await setNormalize('guild-1', true)
    assert.deepEqual(getGuildSettings('guild-1'), { ...DEFAULT_RECORD, normalize: true })

    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.deepEqual(getGuildSettings('guild-1'), { ...DEFAULT_RECORD, normalize: true })
  })
})

test('settings: atomic write leaves a valid JSON settings file', async () => {
  await withTempSettings(async ({ dir, filePath }) => {
    await setNormalize('guild-1', true)
    await setNormalize('guild-2', false)

    const raw = await readFile(filePath, 'utf8')
    assert.deepEqual(JSON.parse(raw), {
      'guild-1': { ...DEFAULT_RECORD, normalize: true },
      'guild-2': { ...DEFAULT_RECORD, normalize: false },
    })

    const files = await readdir(join(dir, 'data'))
    assert.deepEqual(files, ['guild-settings.json'])
  })
})

test('settings: setAutoplayMode rejects invalid modes by falling back to off', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('guild-1', 'bogus')
    assert.equal(getGuildSettings('guild-1').autoplayMode, 'off')

    await setAutoplayMode('guild-1', 'recommend')
    assert.equal(getGuildSettings('guild-1').autoplayMode, 'recommend')
  })
})

test('settings: setPersonalize toggles independently of other fields', async () => {
  await withTempSettings(async () => {
    await setPersonalize('guild-1', true)
    assert.deepEqual(getGuildSettings('guild-1'), { ...DEFAULT_RECORD, personalize: true })
  })
})

test('settings: setAutoNotify persists and defaults to off', async () => {
  await withTempSettings(async ({ filePath }) => {
    assert.equal(getGuildSettings('guild-1').autoNotify, false)

    await setAutoNotify('guild-1', true)
    assert.deepEqual(getGuildSettings('guild-1'), { ...DEFAULT_RECORD, autoNotify: true })

    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.equal(getGuildSettings('guild-1').autoNotify, true)
  })
})

test('settings: setters merge instead of clobbering other fields (regression)', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('guild-1', 'auto')
    await setPersonalize('guild-1', true)
    await setNormalize('guild-1', true)
    await setAutoNotify('guild-1', true)
    assert.deepEqual(getGuildSettings('guild-1'), {
      ...DEFAULT_RECORD,
      normalize: true,
      autoplayMode: 'auto',
      personalize: true,
      autoNotify: true,
    })

    // setNormalize must not wipe autoplay fields set earlier, and vice versa.
    await setNormalize('guild-1', false)
    assert.deepEqual(getGuildSettings('guild-1'), {
      ...DEFAULT_RECORD,
      normalize: false,
      autoplayMode: 'auto',
      personalize: true,
      autoNotify: true,
    })
  })
})

test('settings: setDefaultCommandPermission and setUserCommandPermission resolve with override precedence', async () => {
  await withTempSettings(async () => {
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'allow')

    await setDefaultCommandPermission('guild-1', 'bitrate', 'deny')
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'deny')

    await setUserCommandPermission('guild-1', 'user-1', 'bitrate', 'allow')
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'allow')
    assert.equal(resolveCommandPermission('guild-1', 'user-2', 'bitrate'), 'deny')

    // Clearing the override falls back to the guild default again.
    await setUserCommandPermission('guild-1', 'user-1', 'bitrate', null)
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'deny')
  })
})

test('settings: setCommandVisibility persists per-command overrides', async () => {
  await withTempSettings(async () => {
    assert.deepEqual(getCommandVisibilitySettings('guild-1'), {})

    await setCommandVisibility('guild-1', 'play', 'personal')
    assert.deepEqual(getCommandVisibilitySettings('guild-1'), { play: 'personal' })
  })
})
