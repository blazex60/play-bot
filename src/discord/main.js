import 'dotenv/config'
import { Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js'

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sessions, pendingStore, recommendPendingStore, recommendRounds, destroySession, webClient, sessionVoiceChannelId } from '../playback/sessions.js'
import { parseSearchCustomId } from './views.js'
import { handleQueueEditorInteraction } from './queueEditorInteractions.js'
import { handleRecommendChoice, handleShowRecommendations, RECOMMEND_CUSTOM_ID_PREFIX, RECOMMEND_SHOW_CUSTOM_ID } from './recommendFlow.js'
import { loadSettings, resolveAdminRoleId } from '../shared/settings.js'
import { cleanupStaleTempDir } from '../audio/normalize.js'
import { pruneStemCache, cleanupStaleStemStaging } from '../audio/stemCache.js'
import { startBotApi } from './botApi.js'
import { checkCommandAllowed } from './permissions.js'
import { getAppLogger, getLogger, installProcessHandlers } from '../logging/appLogger.js'
import { randomUUID } from 'node:crypto'

const log = getLogger('main')
installProcessHandlers()
log.info({ event: 'bot.starting', nodeVersion: process.version, pid: process.pid })

const __dirname = dirname(fileURLToPath(import.meta.url))

await loadSettings()
await cleanupStaleTempDir()
// Phase 8 (docs/mix-transition-phase8.md): unlike cleanupStaleTempDir(),
// this must NOT wipe the whole directory on every start — the persistent
// stem cache only pays for itself if entries survive across restarts.
// cleanupStaleStemStaging() runs first (and only here, at startup) to
// remove any .stemsep-* directory orphaned by a killed process/container —
// pruneStemCache() deliberately never touches those (they could belong to
// an in-progress job), so nothing else ever reclaims them (Codex).
await cleanupStaleStemStaging()
await pruneStemCache()

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
})

// Load commands
const commands = new Collection()
const commandsPath = join(__dirname, 'commands')
for (const file of readdirSync(commandsPath).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))) {
  const mod = await import(join(commandsPath, file))
  commands.set(mod.default.data.name, mod.default)
}

client.once(Events.ClientReady, c => {
  log.info({ event: 'bot.ready', clientId: c.user.id, guildCount: c.guilds.cache.size, commandCount: commands.size })
  startBotApi({ client, sessions, commandNames: [...commands.keys()] }).catch(err => {
    log.error({ event: 'botapi.failed_to_start', err }, 'failed to start')
    process.exitCode = 1
  })
})

client.on(Events.Error, err => log.error({ event: 'discord.client_error', err }, 'discord client error'))
client.on(Events.Warn, message => log.warn({ event: 'discord.client_warn' }, message))
client.on(Events.ShardDisconnect, (event, shardId) => log.warn({ event: 'discord.shard_disconnect', shardId, code: event?.code }, 'shard disconnected'))
client.on(Events.ShardReconnecting, shardId => log.info({ event: 'discord.shard_reconnecting', shardId }, 'shard reconnecting'))
client.on(Events.ShardResume, (shardId, replayedEvents) => log.info({ event: 'discord.shard_resume', shardId, replayedEvents }, 'shard resumed'))
client.on(Events.ShardError, (err, shardId) => log.error({ event: 'discord.shard_error', shardId, err }, 'shard error'))

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

    const correlationId = randomUUID()
    const cmdLog = log.child({ correlationId, command: interaction.commandName, guildId: interaction.guildId })
    const startedAt = Date.now()

    if (!checkCommandAllowed(interaction, resolveAdminRoleId(interaction.guildId))) {
      cmdLog.info({ event: 'command.blocked' }, 'command blocked by permission')
      logOperation(false, 'blocked')
      return
    }
    cmdLog.info({ event: 'command.started' })

    try {
      // Commands return `false` on an expected-failure path they've already
      // replied to (not playing, empty queue, etc.) so the operation log
      // reflects what actually happened rather than "the handler didn't
      // throw" — every command file that has such a path returns false there.
      // `null` means "outcome not known yet" (e.g. /play's keyword search
      // just shows a panel; the real result is logged later from onSelect)
      // and is skipped entirely rather than logged as a success.
      const result = await command.execute(interaction, sessions)
      cmdLog.info({
        event: result === false ? 'command.rejected' : 'command.completed',
        outcome: result === null ? 'pending' : result === false ? 'expected_failure' : 'success',
        durationMs: Date.now() - startedAt,
      })
      if (result !== null) {
        logOperation(result !== false)
      }
    } catch (err) {
      cmdLog.error({ event: 'command.failed', durationMs: Date.now() - startedAt, err }, 'command failed')
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

  const botChannel = sessionVoiceChannelId(session)
  if (oldState.channelId !== botChannel) return

  const channel = oldState.guild.channels.cache.get(botChannel)
  if (!channel) return
  const humans = channel.members.filter(m => !m.user.bot)
  if (humans.size === 0) {
    log.info({ event: 'voice.auto_disconnect', guildId: oldState.guild.id, reason: 'all_humans_left' }, 'all humans left, auto-disconnecting')
    destroySession(sessions, oldState.guild.id).catch((err) => log.error({ event: 'voice.disconnect_failed', guildId: oldState.guild.id, err }, 'disconnect failed'))
  }
})

client.login(process.env.DISCORD_TOKEN).catch(err => {
  log.fatal({ event: 'bot.login_failed', err }, 'discord login failed')
  getAppLogger().flushLogs?.()
  process.exit(1)
})
