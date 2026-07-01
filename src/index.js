import 'dotenv/config'
import { Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js'

import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sessions, pendingStore } from './sessions.js'
import { parseSearchCustomId } from './views.js'
import { handleQueueEditorInteraction } from './queueEditorInteractions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
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
})

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = commands.get(interaction.commandName)
    if (!command) return
    try {
      await command.execute(interaction, sessions)
    } catch (err) {
      console.error(`[${interaction.commandName}] error:`, err)
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
    await pending.onSelect(pending.results[index])
    return
  }

  if (interaction.customId?.startsWith('qedit_')) {
    return handleQueueEditorInteraction(interaction, sessions)
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
    session.player.stop().catch(() => {})
    session.connection.destroy()
  }
})

client.login(process.env.DISCORD_TOKEN)
