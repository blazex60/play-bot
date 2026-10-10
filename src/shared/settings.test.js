import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  configureSettingsPathForTest,
  getGuildSettings,
  loadSettings,
  setAutoplayMode,
  setNormalize,
  setFade,
  setPersonalize,
  setAutoNotify,
  setDefaultCommandPermission,
  setUserCommandPermission,
  resolveCommandPermission,
  setCommandVisibility,
  getCommandVisibilitySettings,
  getAdminRoleId,
  setAdminRoleId,
  resolveAdminRoleId,
} from './settings.js'

const DEFAULT_RECORD = {
  normalize: false,
  fade: true,
  autoplayMode: 'off',
  personalize: false,
  autoNotify: false,
  commandPermissions: { defaults: {}, overrides: {} },
  commandVisibility: {},
  adminRoleId: null,
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

test('settings: missing file defaults normalize/fade/autoplayMode/personalize', async () => {
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

test('settings: missing fade field defaults to enabled', async () => {
  await withTempSettings(async ({ filePath }) => {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify({
      'guild-1': {
        normalize: true,
        autoplayMode: 'off',
        personalize: false,
        autoNotify: false,
      },
    }, null, 2)}\n`, 'utf8')

    loadSettings()
    assert.equal(getGuildSettings('guild-1').fade, true)
    assert.equal(getGuildSettings('guild-1').normalize, true)
  })
})

test('settings: setFade persists independently of normalize', async () => {
  await withTempSettings(async ({ filePath }) => {
    await setFade('guild-1', false)
    assert.deepEqual(getGuildSettings('guild-1'), { ...DEFAULT_RECORD, fade: false })

    await setNormalize('guild-1', true)
    assert.equal(getGuildSettings('guild-1').fade, false)
    assert.equal(getGuildSettings('guild-1').normalize, true)

    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.equal(getGuildSettings('guild-1').fade, false)
    assert.equal(getGuildSettings('guild-1').normalize, true)
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
    await setFade('guild-1', false)
    await setAutoNotify('guild-1', true)
    assert.deepEqual(getGuildSettings('guild-1'), {
      ...DEFAULT_RECORD,
      normalize: true,
      fade: false,
      autoplayMode: 'auto',
      personalize: true,
      autoNotify: true,
    })

    // setNormalize must not wipe autoplay fields set earlier, and vice versa.
    await setNormalize('guild-1', false)
    assert.deepEqual(getGuildSettings('guild-1'), {
      ...DEFAULT_RECORD,
      normalize: false,
      fade: false,
      autoplayMode: 'auto',
      personalize: true,
      autoNotify: true,
    })
  })
})

test('settings: setDefaultCommandPermission and setUserCommandPermission resolve with override precedence', async () => {
  await withTempSettings(async ({ filePath }) => {
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'allow')

    await setDefaultCommandPermission('guild-1', 'bitrate', 'deny')
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'deny')

    await setUserCommandPermission('guild-1', 'user-1', 'bitrate', 'allow')
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'allow')
    assert.equal(resolveCommandPermission('guild-1', 'user-2', 'bitrate'), 'deny')

    // Clearing the override falls back to the guild default again.
    await setUserCommandPermission('guild-1', 'user-1', 'bitrate', null)
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'deny')

    // Round-trip through disk to exercise normalizeCommandPermissions, the
    // same path settings.js hits on process restart.
    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.equal(resolveCommandPermission('guild-1', 'user-1', 'bitrate'), 'deny')
    assert.equal(resolveCommandPermission('guild-1', 'user-2', 'bitrate'), 'deny')
  })
})

test('settings: setCommandVisibility persists per-command overrides', async () => {
  await withTempSettings(async ({ filePath }) => {
    assert.deepEqual(getCommandVisibilitySettings('guild-1'), {})

    await setCommandVisibility('guild-1', 'play', 'personal')

    // Round-trip through disk to exercise normalizeCommandVisibility.
    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.deepEqual(getCommandVisibilitySettings('guild-1'), { play: 'personal' })
  })
})

test('settings: resolveAdminRoleId prefers guild override over fallback', async () => {
  await withTempSettings(async ({ filePath }) => {
    assert.equal(getAdminRoleId('guild-1'), null)
    assert.equal(resolveAdminRoleId('guild-1', 'env-role'), 'env-role')

    await setAdminRoleId('guild-1', 'guild-role')
    assert.equal(getAdminRoleId('guild-1'), 'guild-role')
    assert.equal(resolveAdminRoleId('guild-1', 'env-role'), 'guild-role')
    // A guild override must not leak into other guilds.
    assert.equal(resolveAdminRoleId('guild-2', 'env-role'), 'env-role')

    // Round-trip through disk to exercise normalizeRecord's adminRoleId handling.
    configureSettingsPathForTest(filePath)
    loadSettings()
    assert.equal(resolveAdminRoleId('guild-1', 'env-role'), 'guild-role')
  })
})

test('settings: setAdminRoleId(null) clears the override, falling back again', async () => {
  await withTempSettings(async () => {
    await setAdminRoleId('guild-1', 'guild-role')
    assert.equal(resolveAdminRoleId('guild-1', 'env-role'), 'guild-role')

    await setAdminRoleId('guild-1', null)
    assert.equal(getAdminRoleId('guild-1'), null)
    assert.equal(resolveAdminRoleId('guild-1', 'env-role'), 'env-role')
  })
})

test('settings: resolveAdminRoleId with no fallback and no override is null', async () => {
  await withTempSettings(async () => {
    const previousEnv = process.env.ADMIN_ROLE_ID
    delete process.env.ADMIN_ROLE_ID
    try {
      assert.equal(resolveAdminRoleId('guild-1'), null)
      assert.equal(resolveAdminRoleId('guild-1', undefined), null)
    } finally {
      if (previousEnv === undefined) delete process.env.ADMIN_ROLE_ID
      else process.env.ADMIN_ROLE_ID = previousEnv
    }
  })
})
