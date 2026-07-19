import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice'
import { GuildQueue } from './queue.js'
import { GuildPlayer } from './player.js'
import { PendingChoiceStore } from './views.js'
import { createWebClient } from './webClient.js'
import { planAutoTrack, planRecommendations } from './autoplay.js'
import { cancelRecommendations, postRecommendations } from './recommendFlow.js'

// Map<guildId, { guildId, connection, player, queue, textChannelId }>
export const sessions = new Map()
export const pendingStore = new PendingChoiceStore()
export const recommendPendingStore = new PendingChoiceStore()

const webClient = createWebClient()

export async function getOrCreateSession({ guildId, guild, channel, textChannelId = null }) {
  const existing = sessions.get(guildId)
  if (existing && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    if (textChannelId) existing.textChannelId = textChannelId
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
      cancelRecommendations(guildId, recommendPendingStore)
      if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        s.connection.destroy()
      }
    }
  }

  const handleQueueExhausted = async (lastTrack) => {
    const session = sessions.get(guildId)
    if (!session) return false
    const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId)
    if (!voiceChannel) return false

    const autoTrack = await planAutoTrack({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient })
    if (autoTrack) {
      queue.add(autoTrack)
      await session.player.playNext()
      return true
    }

    const plans = await planRecommendations({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient })
    if (plans && plans.length > 0) {
      const textChannelId = session.textChannelId
      const textChannel = textChannelId ? guild.channels.cache.get(textChannelId) : null
      if (!textChannel) return false
      await postRecommendations({
        client: guild.client,
        channel: textChannel,
        guildId,
        plans,
        queue,
        player: session.player,
        pendingStore: recommendPendingStore,
        onTimeout: onDisconnect,
      })
      return true
    }

    return false
  }

  const player = new GuildPlayer({ guildId, connection, queue, onDisconnect, handleQueueExhausted })
  const session = { guildId, connection, player, queue, textChannelId }
  sessions.set(guildId, session)
  return session
}
