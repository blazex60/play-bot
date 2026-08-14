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
    assert.equal(enable.replies[0].content, '✅ フェードを **有効** にしました')
  })
})
