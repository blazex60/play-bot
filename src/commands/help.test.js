import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MessageFlags } from 'discord.js'
import helpCommand from './help.js'
import { configureSettingsPathForTest, setCommandVisibility } from '../settings.js'

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-help-command-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  try {
    await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function createInteraction() {
  const replies = []
  return {
    guildId: 'guild-1',
    reply: async (payload) => { replies.push(payload) },
    replies,
  }
}

test('help: normalizes the detailed-help URL and uses the configured visibility', async () => {
  await withTempSettings(async () => {
    const previousBaseUrl = process.env.PUBLIC_BASE_URL
    process.env.PUBLIC_BASE_URL = 'https://example.com///'
    try {
      await setCommandVisibility('guild-1', 'help', 'personal')
      const interaction = createInteraction()

      await helpCommand.execute(interaction, new Map())

      assert.equal(interaction.replies.length, 1)
      assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral)
      const detailField = interaction.replies[0].embeds[0].data.fields.find((field) => field.name === '詳細なヘルプ')
      assert.match(detailField.value, /https:\/\/example\.com\/help/)
      assert.doesNotMatch(detailField.value, /example\.com\/\/help/)
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.PUBLIC_BASE_URL
      } else {
        process.env.PUBLIC_BASE_URL = previousBaseUrl
      }
    }
  })
})
