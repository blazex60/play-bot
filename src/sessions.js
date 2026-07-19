import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice'
import { GuildQueue } from './queue.js'
import { GuildPlayer } from './player.js'
import { PendingChoiceStore } from './views.js'
import { createWebClient } from './webClient.js'
import { planAutoTrack, planRecommendations } from './autoplay.js'
import { cancelRecommendations, postRecommendations } from './recommendFlow.js'

// Map<guildId, { guildId, connection, player, queue, textChannelId, planToken }>
export const sessions = new Map()
export const pendingStore = new PendingChoiceStore()
export const recommendPendingStore = new PendingChoiceStore()

const webClient = createWebClient()

// /stop clears playback without destroying the session/connection, and
// /leave deletes the session directly — neither goes through onDisconnect,
// so both must explicitly drop any still-open recommendation prompts for
// the guild (otherwise a stale button click can still enqueue and start a
// track after the user thought they stopped/left).
export function cancelPendingRecommendations(guildId) {
  cancelRecommendations(guildId, recommendPendingStore)
}

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
    // planAutoTrack/planRecommendations do multi-second async work (history
    // fetch, yt-dlp). /stop can clear the queue in that window without
    // deleting the session, which would otherwise make queue.isEmpty look
    // "still idle" again and let this continuation undo the stop. planToken
    // is bumped on /stop so a stale continuation can tell it happened.
    const planToken = session.planToken
    const isStale = () => sessions.get(guildId) !== session || session.planToken !== planToken

    const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId)
    if (!voiceChannel) return false

    const autoTrack = await planAutoTrack({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient })
    if (isStale()) return false
    if (autoTrack) {
      // A manual /play may have already re-filled and started the queue
      // while we were waiting, so only auto-start playback if still idle.
      const wasEmpty = queue.isEmpty
      queue.add(autoTrack)
      if (wasEmpty) await session.player.playNext()
      return true
    }

    const plans = await planRecommendations({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient })
    if (isStale()) return false
    if (plans && plans.length > 0) {
      const textChannelId = session.textChannelId
      const textChannel = textChannelId ? guild.channels.cache.get(textChannelId) : null
      if (!textChannel) return false
      const postedCount = await postRecommendations({
        client: guild.client,
        channel: textChannel,
        guildId,
        plans,
        queue,
        player: session.player,
        pendingStore: recommendPendingStore,
        onTimeout: async () => {
          // A manual /play may have started a track while this prompt sat
          // unanswered; only the shared onDisconnect path should tear the
          // session down, and only if nothing is actually playing/queued.
          if (!queue.isEmpty || isStale()) return
          await onDisconnect()
        },
      })
      return postedCount > 0
    }

    return false
  }

  const player = new GuildPlayer({
    guildId,
    connection,
    queue,
    onDisconnect,
    handleQueueExhausted,
    recordPlayFn: webClient.recordPlay,
  })
  // A voice channel's own built-in chat can receive messages too, so a
  // session created without an interaction text channel (e.g. an import
  // that starts playback with no /play command in the picture) still gets
  // somewhere to post recommend-mode choices instead of recommend mode
  // silently falling through to a disconnect at the next queue exhaustion.
  const session = { guildId, connection, player, queue, textChannelId: textChannelId ?? channel.id, planToken: 0 }
  sessions.set(guildId, session)
  return session
}
