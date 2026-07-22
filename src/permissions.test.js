import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageFlags } from 'discord.js'
import { configureSettingsPathForTest, setDefaultCommandPermission, setUserCommandPermission, setCommandVisibility } from './settings.js'
import { checkCommandAllowed, replyFlags, getEffectiveCommandVisibility, sendVisibleFollowUp } from './permissions.js'

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

// Models the discord.js quirk exercised by sendVisibleFollowUp: the first
// followUp sent for an interaction ignores its own flags and always lands
// with whatever ephemeral state `ephemeral` (set from the original
// deferReply/reply) already has — only the second followUp onward is free.
function fakeDeferredInteraction(ephemeral) {
  const calls = { followUp: [], deleteReply: [] }
  let followUpCount = 0
  let nextMessageId = 1
  return {
    ephemeral,
    calls,
    followUp: async (payload) => {
      followUpCount += 1
      const actualEphemeral = followUpCount === 1 ? ephemeral : Boolean(payload.flags)
      const message = { id: String(nextMessageId++), content: payload.content, ephemeral: actualEphemeral }
      calls.followUp.push({ payload, actualEphemeral })
      return message
    },
    deleteReply: async (messageId) => { calls.deleteReply.push(messageId) },
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
    assert.deepEqual(replyFlags('guild-1', 'help'), { flags: MessageFlags.Ephemeral })
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

test('sendVisibleFollowUp: sends a single followUp when the target visibility already matches the deferred state', async () => {
  const interaction = fakeDeferredInteraction(true)
  const message = await sendVisibleFollowUp(interaction, 'hello', { flags: MessageFlags.Ephemeral })
  assert.equal(interaction.calls.followUp.length, 1)
  assert.equal(interaction.calls.deleteReply.length, 0)
  assert.equal(message.content, 'hello')
  assert.equal(message.ephemeral, true)
})

test('sendVisibleFollowUp: burns a throwaway followUp to make a public message land after an ephemeral defer', async () => {
  const interaction = fakeDeferredInteraction(true)
  const message = await sendVisibleFollowUp(interaction, 'public result', {})
  assert.equal(interaction.calls.followUp.length, 2)
  // The first followUp is forced ephemeral regardless of the flags we asked
  // for, matching the real Discord quirk this is working around.
  assert.equal(interaction.calls.followUp[0].actualEphemeral, true)
  assert.equal(interaction.calls.deleteReply.length, 1)
  assert.equal(interaction.calls.deleteReply[0], '1')
  assert.equal(interaction.calls.followUp[1].actualEphemeral, false)
  assert.equal(message.content, 'public result')
  assert.equal(message.ephemeral, false)
})

test('sendVisibleFollowUp: burns a throwaway followUp to make an ephemeral message land after a public defer', async () => {
  const interaction = fakeDeferredInteraction(false)
  const message = await sendVisibleFollowUp(interaction, 'personal result', { flags: MessageFlags.Ephemeral })
  assert.equal(interaction.calls.followUp.length, 2)
  assert.equal(interaction.calls.followUp[0].actualEphemeral, false)
  assert.equal(interaction.calls.followUp[1].actualEphemeral, true)
  assert.equal(message.ephemeral, true)
})
