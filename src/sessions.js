import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice'
import { GuildQueue } from './queue.js'
import { GuildPlayer } from './player.js'
import { SearchPendingStore } from './views.js'

// Map<guildId, { connection, player, queue }>
export const sessions = new Map()
export const pendingStore = new SearchPendingStore()

export async function getOrCreateSession({ guildId, guild, channel }) {
  const existing = sessions.get(guildId)
  if (existing && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    return existing
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  })

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
  } catch {
    connection.destroy()
    throw new Error('VC への接続がタイムアウトしました')
  }

  const queue = new GuildQueue()

  const onDisconnect = async () => {
    const s = sessions.get(guildId)
    if (s) {
      sessions.delete(guildId)
      if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        s.connection.destroy()
      }
    }
  }

  const player = new GuildPlayer({ guildId, connection, queue, onDisconnect })
  const session = { connection, player, queue }
  sessions.set(guildId, session)
  return session
}
