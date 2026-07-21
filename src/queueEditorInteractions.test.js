import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureSettingsPathForTest, setDefaultCommandPermission } from './settings.js'
import { GuildQueue, createTrack } from './queue.js'
import { handleQueueEditorInteraction } from './queueEditorInteractions.js'

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-qedit-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeSession({ channelId = 'voice-1' } = {}) {
  const queue = new GuildQueue()
  queue.add(createTrack({ title: 'current', webpageUrl: 'https://example.com/current', duration: 60, requestedBy: 'tester' }))
  queue.add(createTrack({ title: 'next', webpageUrl: 'https://example.com/next', duration: 60, requestedBy: 'tester' }))
  return { connection: { joinConfig: { channelId } }, queue }
}

function fakeInteraction({ customId, kind = 'button', guildId = 'guild-1', userId = 'user-1', channelId = 'voice-1', roles = [] } = {}) {
  const calls = { reply: [], followUp: [], update: [] }
  return {
    customId,
    guildId,
    channelId,
    user: { id: userId },
    member: { roles: { cache: { has: (id) => roles.includes(id) } }, voice: { channelId } },
    deferred: false,
    replied: false,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    isModalSubmit: () => kind === 'modal',
    reply: async (payload) => { calls.reply.push(payload); return payload },
    followUp: async (payload) => { calls.followUp.push(payload); return payload },
    update: async (payload) => { calls.update.push(payload); return payload },
    calls,
  }
}

test('handleQueueEditorInteraction: a user denied the queue command cannot remove a track via the editor buttons', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_remove_p0_i0' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial instead of silently doing nothing')
    assert.equal(interaction.calls.update.length, 0, 'must not touch the queue editor message')
    assert.equal(session.queue.upcoming().length, 1, 'must not remove the track (regression: qedit_ actions bypassed checkCommandAllowed)')
  })
})

test('handleQueueEditorInteraction: a user denied the queue command cannot reorder via the select menu', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_select_p0', kind: 'select' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial')
    assert.equal(interaction.calls.update.length, 0, 'must not touch the queue editor message')
  })
})

test('handleQueueEditorInteraction: a user denied the queue command cannot jump via the modal submit', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_jumpmodal_p0_i0', kind: 'modal' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial')
    assert.equal(interaction.calls.update.length, 0, 'must not move the track')
    assert.equal(session.queue.upcoming().length, 1, 'queue must be unchanged')
  })
})

test('handleQueueEditorInteraction: an allowed user can still remove a track via the editor buttons', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    const sessions = new Map([['guild-1', session]])
    const interaction = fakeInteraction({ customId: 'qedit_remove_p0_i0' })

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(interaction.calls.update.length, 1)
    assert.equal(session.queue.upcoming().length, 0)
  })
})

test('handleQueueEditorInteraction: a user denied the queue command cannot close someone else\'s public panel', async () => {
  await withTempSettings(async () => {
    await setDefaultCommandPermission('guild-1', 'queue', 'deny')
    const session = makeSession()
    session.connection.destroy = () => {}
    const sessions = new Map([['guild-1', session]])
    let deleted = false
    const interaction = fakeInteraction({ customId: 'qedit_close_p0' })
    interaction.deferUpdate = async () => {}
    interaction.message = { delete: async () => { deleted = true } }

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(deleted, false, 'a denied user must not be able to dismiss a public queue panel (regression: qedit_close bypassed checkCommandAllowed)')
    assert.equal(interaction.calls.reply.length, 1, 'must reply with a denial')
  })
})

test('handleQueueEditorInteraction: an allowed user can close the editor', async () => {
  await withTempSettings(async () => {
    const session = makeSession()
    session.connection.destroy = () => {}
    const sessions = new Map([['guild-1', session]])
    let deleted = false
    const interaction = fakeInteraction({ customId: 'qedit_close_p0' })
    interaction.deferUpdate = async () => {}
    interaction.message = { delete: async () => { deleted = true } }

    await handleQueueEditorInteraction(interaction, sessions)

    assert.equal(deleted, true)
  })
})
