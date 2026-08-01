import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageFlags } from 'discord.js'
import adminRoleCommand from './adminrole.js'
import { configureSettingsPathForTest, getSettingsPathForTest, getAdminRoleId } from '../settings.js'

async function withTempSettings(fn) {
  const previousSettingsPath = getSettingsPathForTest()
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-adminrole-command-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    configureSettingsPathForTest(previousSettingsPath)
    await rm(dir, { recursive: true, force: true })
  }
}

function createInteraction({ isAdmin = true, subcommand = 'show', role = null } = {}) {
  const replies = []
  return {
    guildId: 'guild-1',
    memberPermissions: { has: () => isAdmin },
    options: {
      getSubcommand: () => subcommand,
      getRole: () => role,
    },
    reply: async (payload) => { replies.push(payload) },
    replies,
  }
}

test('adminrole: rejects a non-administrator and returns false', async () => {
  const interaction = createInteraction({ isAdmin: false })

  const result = await adminRoleCommand.execute(interaction, new Map())

  assert.equal(result, false)
  assert.equal(interaction.replies.length, 1)
  assert.equal(interaction.replies[0].content, '❌ このコマンドは管理者権限が必要です')
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral)
})

test('adminrole set: stores the role id for the guild and confirms', async () => {
  await withTempSettings(async () => {
    const role = { id: 'role-123' }
    const interaction = createInteraction({ subcommand: 'set', role })

    await adminRoleCommand.execute(interaction, new Map())

    assert.equal(getAdminRoleId('guild-1'), 'role-123')
    assert.match(interaction.replies[0].content, /<@&role-123>/)
    assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral)
  })
})

test('adminrole clear: removes the guild override', async () => {
  await withTempSettings(async () => {
    const setInteraction = createInteraction({ subcommand: 'set', role: { id: 'role-123' } })
    await adminRoleCommand.execute(setInteraction, new Map())

    const clearInteraction = createInteraction({ subcommand: 'clear' })
    await adminRoleCommand.execute(clearInteraction, new Map())

    assert.equal(getAdminRoleId('guild-1'), null)
    assert.match(clearInteraction.replies[0].content, /解除しました/)
  })
})

test('adminrole show: reflects the guild override when set', async () => {
  await withTempSettings(async () => {
    const setInteraction = createInteraction({ subcommand: 'set', role: { id: 'role-123' } })
    await adminRoleCommand.execute(setInteraction, new Map())

    const showInteraction = createInteraction({ subcommand: 'show' })
    await adminRoleCommand.execute(showInteraction, new Map())

    assert.match(showInteraction.replies[0].content, /<@&role-123>/)
    assert.match(showInteraction.replies[0].content, /このサーバー専用設定/)
  })
})

test('adminrole show: reflects the env fallback when no guild override exists', async () => {
  await withTempSettings(async () => {
    const previousEnv = process.env.ADMIN_ROLE_ID
    process.env.ADMIN_ROLE_ID = 'env-role'
    try {
      const showInteraction = createInteraction({ subcommand: 'show' })
      await adminRoleCommand.execute(showInteraction, new Map())

      assert.match(showInteraction.replies[0].content, /<@&env-role>/)
      assert.match(showInteraction.replies[0].content, /環境変数のデフォルト/)
    } finally {
      if (previousEnv === undefined) delete process.env.ADMIN_ROLE_ID
      else process.env.ADMIN_ROLE_ID = previousEnv
    }
  })
})

test('adminrole show: reports unset when neither guild override nor env fallback exists', async () => {
  await withTempSettings(async () => {
    const previousEnv = process.env.ADMIN_ROLE_ID
    delete process.env.ADMIN_ROLE_ID
    try {
      const showInteraction = createInteraction({ subcommand: 'show' })
      await adminRoleCommand.execute(showInteraction, new Map())

      assert.match(showInteraction.replies[0].content, /未設定/)
    } finally {
      if (previousEnv !== undefined) process.env.ADMIN_ROLE_ID = previousEnv
    }
  })
})
