import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageFlags } from 'discord.js'
import { configureSettingsPathForTest, setDefaultCommandPermission, setUserCommandPermission, setCommandVisibility } from './settings.js'
import { checkCommandAllowed, replyFlags, getEffectiveCommandVisibility } from './permissions.js'

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-permissions-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function fakeInteraction({ guildId = 'guild-1', userId = 'user-1', commandName = 'skip', roles = [] } = {}) {
  const calls = { reply: [], followUp: [] }
  return {
    guildId,
    commandName,
    user: { id: userId },
    member: { roles: { cache: { has: (id) => roles.includes(id) } } },
    deferred: false,
    replied: false,
    reply: async (payload) => { calls.reply.push(payload); return payload },
    followUp: async (payload) => { calls.followUp.push(payload); return payload },
    calls,
  }
}

test('checkCommandAllowed: allows by default', async () => {
  await withTempSettings(async () => {
    const interaction = fakeInteraction()
    assert.equal(checkCommandAllowed(interaction, undefined), true)
    assert.equal(interaction.calls.reply.length, 0)
  })
})

test('checkCommandAllowed: denies and replies ephemeral when blocked', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'skip', 'deny')
    const interaction = fakeInteraction()
    assert.equal(checkCommandAllowed(interaction, undefined), false)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(interaction.calls.reply.length, 1)
    assert.equal(interaction.calls.reply[0].flags, MessageFlags.Ephemeral)
  })
})

test('checkCommandAllowed: per-user override takes precedence over guild default', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'skip', 'deny')
    await setUserCommandPermission('guild-1', 'user-1', 'skip', 'allow')
    const interaction = fakeInteraction({ userId: 'user-1' })
    assert.equal(checkCommandAllowed(interaction, undefined), true)

    const otherInteraction = fakeInteraction({ userId: 'user-2' })
    assert.equal(checkCommandAllowed(otherInteraction, undefined), false)
  })
})

test('checkCommandAllowed: admin role bypasses a deny setting', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'skip', 'deny')
    const interaction = fakeInteraction({ roles: ['admin-role'] })
    assert.equal(checkCommandAllowed(interaction, 'admin-role'), true)
  })
})

test('checkCommandAllowed: an explicit commandName overrides interaction.commandName (component interactions have none)', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    // Simulates a button/select/modal interaction: no commandName of its own.
    const interaction = fakeInteraction({ commandName: null })
    assert.equal(checkCommandAllowed(interaction, undefined, 'queue'), false)
    assert.equal(interaction.calls.reply.length, 1)
  })
})

test('replyFlags: falls back to hardcoded default visibility per command', async () => {
  await withTempSettings(async () => {
    assert.deepEqual(replyFlags('guild-1', 'skip'), {})
    assert.deepEqual(replyFlags('guild-1', 'nowplaying'), { flags: MessageFlags.Ephemeral })
  })
})

test('replyFlags: guild override changes effective visibility', async () => {
  await withTempSettings(async () => {
    await setCommandVisibility('guild-1', 'play', 'personal')
    assert.equal(getEffectiveCommandVisibility('guild-1', 'play'), 'personal')
    assert.deepEqual(replyFlags('guild-1', 'play'), { flags: MessageFlags.Ephemeral })

    await setCommandVisibility('guild-1', 'nowplaying', 'public')
    assert.deepEqual(replyFlags('guild-1', 'nowplaying'), {})
  })
})
