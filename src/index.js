import 'dotenv/config'
import { Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js'

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sessions, pendingStore, recommendPendingStore, recommendRounds, cancelPendingRecommendations, webClient } from './sessions.js'
import { parseSearchCustomId } from './views.js'
import { handleQueueEditorInteraction } from './queueEditorInteractions.js'
import { handleRecommendChoice, handleShowRecommendations, RECOMMEND_CUSTOM_ID_PREFIX, RECOMMEND_SHOW_CUSTOM_ID } from './recommendFlow.js'
import { loadSettings } from './settings.js'
import { cleanupStaleTempDir } from './normalize.js'
import { startBotApi } from './botApi.js'
import { checkCommandAllowed } from './permissions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

await loadSettings()
await cleanupStaleTempDir()

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
})

// Load commands
const commands = new Collection()
const commandsPath = join(__dirname, 'commands')
for (const file of readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const mod = await import(join(commandsPath, file))
  commands.set(mod.default.data.name, mod.default)
}

client.once(Events.ClientReady, c => {
  console.log(`Bot ready: ${c.user.tag} (id=${c.user.id})`)
  startBotApi({ client, sessions, commandNames: [...commands.keys()] }).catch(err => {
    console.error('[bot-api] failed to start:', err)
    process.exitCode = 1
  })
})

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName)
    if (!command) return

    const logOperation = (success, detail) => webClient.logOperation({
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      username: interaction.user.username,
      source: 'command',
      action: interaction.commandName,
      success,
      detail,
    })

    if (!checkCommandAllowed(interaction, process.env.ADMIN_ROLE_ID)) {
      logOperation(false, 'blocked')
      return
    }

    try {
      // Commands return `false` on an expected-failure path they've already
      // replied to (not playing, empty queue, etc.) so the operation log
      // reflects what actually happened rather than "the handler didn't
      // throw" — every command file that has such a path returns false there.
      // `null` means "outcome not known yet" (e.g. /play's keyword search
      // just shows a panel; the real result is logged later from onSelect)
      // and is skipped entirely rather than logged as a success.
      const result = await command.execute(interaction, sessions)
      if (result !== null) {
        logOperation(result !== false)
      }
    } catch (err) {
      console.error(`[${interaction.commandName}] error:`, err)
      logOperation(false, err.message)
      const reply = { content: '❌ コマンドの実行中にエラーが発生しました', flags: MessageFlags.Ephemeral }
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => {})
      } else {
        await interaction.reply(reply).catch(() => {})
      }
    }
    return
  }

  if (interaction.isButton() && interaction.customId.startsWith('search_')) {
    const index = parseSearchCustomId(interaction.customId)
    if (index === null) return
    const pending = pendingStore.get(interaction.message.id)
    if (!pending) return interaction.reply({ content: '❌ 検索セッションが期限切れです', flags: MessageFlags.Ephemeral })
    pendingStore.delete(interaction.message.id)
    await interaction.deferUpdate()
    await pending.onSelect(pending.results[index], interaction)
    return
  }

  if (interaction.customId?.startsWith('qedit_')) {
    return handleQueueEditorInteraction(interaction, sessions)
  }

  if (interaction.isButton() && interaction.customId === RECOMMEND_SHOW_CUSTOM_ID) {
    return handleShowRecommendations(interaction, sessions, recommendRounds, recommendPendingStore)
  }

  if (interaction.isButton() && interaction.customId.startsWith(`${RECOMMEND_CUSTOM_ID_PREFIX}_`)) {
    return handleRecommendChoice(interaction, sessions, recommendPendingStore, recommendRounds)
  }
})

client.on(Events.VoiceStateUpdate, async (oldState) => {
  if (oldState.member?.id === client.user.id) return

  const session = sessions.get(oldState.guild.id)
  if (!session) return

  const botChannel = session.connection.joinConfig.channelId
  if (oldState.channelId !== botChannel) return

  const channel = oldState.guild.channels.cache.get(botChannel)
  if (!channel) return
  const humans = channel.members.filter(m => !m.user.bot)
  if (humans.size === 0) {
    console.log(`[VoiceState] All humans left ${channel.name}, auto-disconnecting`)
    sessions.delete(oldState.guild.id)
    cancelPendingRecommendations(oldState.guild.id)
    session.player.stop().catch(() => {})
    session.connection.destroy()
  }
})

client.login(process.env.DISCORD_TOKEN)
