import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageFlags } from 'discord.js'
import fadeCommand from './fade.js'
import { configureSettingsPathForTest, getGuildSettings, getSettingsPathForTest } from '../settings.js'

async function withTempSettings(fn) {
  const previousSettingsPath = getSettingsPathForTest()
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-fade-command-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    configureSettingsPathForTest(previousSettingsPath)
    await rm(dir, { recursive: true, force: true })
  }
}

function createInteraction(enabled) {
  const replies = []
  return {
    guildId: 'guild-1',
    options: {
      getBoolean: (name, required) => {
        assert.equal(name, 'enabled')
        assert.equal(required, true)
        return enabled
      },
    },
    reply: async (payload) => { replies.push(payload) },
    replies,
  }
}

test('fade: defaults to enabled and persists the guild toggle', async () => {
  await withTempSettings(async () => {
    assert.equal(getGuildSettings('guild-1').fade, true)

    const disable = createInteraction(false)
    await fadeCommand.execute(disable)
    assert.equal(getGuildSettings('guild-1').fade, false)
    assert.equal(disable.replies[0].flags, MessageFlags.Ephemeral)
    assert.match(disable.replies[0].content, /無効/)

    const enable = createInteraction(true)
    await fadeCommand.execute(enable)
    assert.equal(getGuildSettings('guild-1').fade, true)
    assert.match(enable.replies[0].content, /有効/)
  })
})

test('fade: notes when the mixer process flag is off', async () => {
  await withTempSettings(async () => {
    const previous = process.env.MIXER_ENABLED
    delete process.env.MIXER_ENABLED
    try {
      const interaction = createInteraction(false)
      await fadeCommand.execute(interaction)
      assert.match(interaction.replies[0].content, /ミキサーが無効/)
    } finally {
      if (previous === undefined) delete process.env.MIXER_ENABLED
      else process.env.MIXER_ENABLED = previous
    }
  })
})

test('fade: omits the mixer note when MIXER_ENABLED is true', async () => {
  await withTempSettings(async () => {
    const previous = process.env.MIXER_ENABLED
    process.env.MIXER_ENABLED = 'true'
    try {
      const interaction = createInteraction(true)
      await fadeCommand.execute(interaction)
      assert.equal(interaction.replies[0].content, '✅ フェードを **有効** にしました')
    } finally {
      if (previous === undefined) delete process.env.MIXER_ENABLED
      else process.env.MIXER_ENABLED = previous
    }
  })
})
