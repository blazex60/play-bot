import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice'
import { GuildQueue } from './queue.js'
import { GuildPlayer } from './player.js'
import { PendingChoiceStore } from './views.js'
import { createWebClient } from './webClient.js'
import { cancelRecommendations } from './recommendFlow.js'
import {
  createQueueExhaustionHandler,
  claimAutoplayContinuation,
  releaseAutoplayContinuation,
  hasAutoplayContinuationBeenUsed,
} from './queueExhaustion.js'

// Map<guildId, { guildId, connection, player, queue, textChannelId, planToken, autoplayContinuationUsed, recentPlayedVideoIds }>
export const sessions = new Map()

// How many recently-played videoIds a live VC session remembers, so autoplay
// can avoid re-picking them. Resets to empty whenever a new session object is
// created (VC rejoin) rather than persisting across sessions — see
// getOrCreateSession below.
export const MAX_SESSION_HISTORY = 100

// Exported (rather than inlined in getOrCreateSession's onTrackStart closure)
// so it's unit-testable without going through the real joinVoiceChannel flow.
export function recordPlayedVideoId(session, videoId) {
  if (!session || !videoId) return
  session.recentPlayedVideoIds.push(videoId)
  if (session.recentPlayedVideoIds.length > MAX_SESSION_HISTORY) {
    session.recentPlayedVideoIds.shift()
  }
}

export const pendingStore = new PendingChoiceStore()
export const recommendPendingStore = new PendingChoiceStore()
// Map<guildId, { guildId, candidatesByUserId, message, timeoutHandle, expired }>
// One shared "おすすめを表示" round per guild — see recommendFlow.js.
export const recommendRounds = new Map()

export const webClient = createWebClient()

// /stop clears playback without destroying the session/connection, and
// /leave deletes the session directly — neither goes through onDisconnect,
// so both must explicitly drop any still-open recommendation prompts for
// the guild (otherwise a stale button click can still enqueue and start a
// track after the user thought they stopped/left).
export function cancelPendingRecommendations(guildId) {
  cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
}

// Invalidates any queue-exhaustion planning currently in flight for a guild.
// Call this whenever something changes state that in-flight planning already
// read before its first await — stopping playback, or flipping autoplayMode/
// personalize — so a stale continuation can't act on outdated assumptions.
export function bumpPlanToken(guildId) {
  const session = sessions.get(guildId)
  if (session) session.planToken += 1
}

// Re-exported for backward compatibility (sessions.test.js and any future
// caller import these from here) — the actual lock implementation now lives
// in queueExhaustion.js, next to the handler it guards.
export { claimAutoplayContinuation, releaseAutoplayContinuation, hasAutoplayContinuationBeenUsed }

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

  // Assigned once at the bottom of this function; onDisconnect closes over
  // this binding (not a snapshot) so it can tell whether it's still the
  // current session for the guild by the time it actually runs.
  let session

  const onDisconnect = async () => {
    const s = sessions.get(guildId)
    // handleQueueExhausted's async planning can still be in flight when
    // /leave deletes this session and a fresh /play immediately creates a
    // new one for the same guild. Without this identity check, this stale
    // closure would delete and destroy that brand new, unrelated session.
    if (s && s === session) {
      sessions.delete(guildId)
      cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
      if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        s.connection.destroy()
      }
    }
  }

  const handleQueueExhausted = createQueueExhaustionHandler({
    guildId,
    guild,
    connection,
    queue,
    getSession: () => sessions.get(guildId),
    onDisconnect,
    webClient,
    recommendPendingStore,
    recommendRounds,
  })

  // Like onDisconnect above, this closes over the `session` binding (not a
  // snapshot) so it can read session.recentPlayedVideoIds once playback
  // actually starts, even though GuildPlayer is constructed before `session`
  // is assigned below.
  const onTrackStart = (videoId) => recordPlayedVideoId(session, videoId)

  const player = new GuildPlayer({
    guildId,
    connection,
    queue,
    onDisconnect,
    handleQueueExhausted,
    recordPlayFn: webClient.recordPlay,
    onTrackStart,
    getTrackAnalysisFn: (videoId) => webClient.getTrackAnalysis(videoId),
    putTrackAnalysisFn: (videoId, analysis) => webClient.putTrackAnalysis(videoId, analysis),
  })
  // A voice channel's own built-in chat can receive messages too, so a
  // session created without an interaction text channel (e.g. an import
  // that starts playback with no /play command in the picture) still gets
  // somewhere to post recommend-mode choices instead of recommend mode
  // silently falling through to a disconnect at the next queue exhaustion.
  session = { guildId, connection, player, queue, textChannelId: textChannelId ?? channel.id, planToken: 0, autoplayContinuationUsed: false, recentPlayedVideoIds: [] }
  sessions.set(guildId, session)
  return session
}
