import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice'
import { GuildQueue } from './queue.js'
import { GuildPlayer } from './player.js'
import { PendingChoiceStore } from '../shared/pendingChoiceStore.js'
import { createWebClient } from '../shared/webClient.js'
import {
  createQueueExhaustionHandler,
  claimAutoplayContinuation,
  releaseAutoplayContinuation,
  hasAutoplayContinuationBeenUsed,
} from './queueExhaustion.js'
import { PlaybackService } from './playbackService.js'

// Map<guildId, { guildId, connection, player, queue, textChannelId, planToken, autoplayContinuationUsed, recentPlayedVideoIds, recommendHooks }>
export const sessions = new Map()

// Builds the in-process playback facade bound to a given sessions Map.
// Commands/handlers receive a sessions Map as an argument (tests inject
// fakes), so they bind their service to that map rather than the global
// singleton below. onStopStart/onStop are what make playback.stop() the
// application-level "stop": in-flight autoplay planning is invalidated
// and pending recommendation prompts are cancelled so nothing can
// resurrect playback on top of the stop.
export function playbackFor(sessionsMap) {
  // Session-bound invalidation (deliberately NOT the map-bound
  // bumpPlanToken/cancelPendingRecommendations helpers): the point is
  // killing THIS session's in-flight plans and prompts, so the effect
  // must land on the session object captured by PlaybackService.stop —
  // immune to a leave+rejoin swapping the map entry mid-stop.
  const invalidateSession = (guildId, session) => {
    session.planToken += 1
    session.recommendHooks?.cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
  }
  return new PlaybackService({
    getSession: (guildId) => sessionsMap.get(guildId),
    onStopStart: invalidateSession,
    onStop: invalidateSession,
  })
}

// Shared facade for callers that operate on the global sessions Map.
export const playback = playbackFor(sessions)

// Canonical session teardown (used by /leave and the VC-emptied auto
// disconnect): drop the registry entry first so GuildPlayer's deferred
// onDisconnect can't double-destroy, then stop playback and destroy the
// connection. Stop failures are swallowed — teardown must always finish.
export async function destroySession(sessionsMap, guildId) {
  const session = sessionsMap.get(guildId)
  if (!session) return
  sessionsMap.delete(guildId)
  // Uses the session's own injected hooks rather than
  // cancelPendingRecommendations(sessionsMap, guildId): the map entry is
  // already gone by this point, so a map lookup could not find it anyway.
  session.recommendHooks?.cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
  await session.player.stop().catch(() => {})
  session.connection.destroy()
}

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

// Recommendation prompts are a Discord-adapter concern (recommendFlow.js),
// which playback can't import without creating a playback→discord edge, so
// the functions the teardown/exhaustion paths need are injected per session
// through getOrCreateSession's config (see discord/recommendHooks.js).
// Sessions created without them (tests, adapters with no recommend support)
// get no-ops: the exhaustion handler still plans, prompts just never post.
const NOOP_RECOMMEND_HOOKS = {
  cancelRecommendations: () => {},
  hasPendingForGuild: () => false,
  postRecommendationPrompt: async () => 0,
}

// /stop clears playback without destroying the session/connection, and
// /leave deletes the session directly — neither goes through onDisconnect,
// so both must explicitly drop any still-open recommendation prompts for
// the guild (otherwise a stale button click can still enqueue and start a
// track after the user thought they stopped/left).
export function cancelPendingRecommendations(sessionsMap, guildId) {
  sessionsMap.get(guildId)?.recommendHooks?.cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
}

// Invalidates any queue-exhaustion planning currently in flight for a guild.
// Call this whenever something changes state that in-flight planning already
// read before its first await — stopping playback, or flipping autoplayMode/
// personalize — so a stale continuation can't act on outdated assumptions.
export function bumpPlanToken(sessionsMap, guildId) {
  const session = sessionsMap.get(guildId)
  if (session) session.planToken += 1
}

// Re-exported for backward compatibility (sessions.test.js and any future
// caller import these from here) — the actual lock implementation now lives
// in queueExhaustion.js, next to the handler it guards.
export { claimAutoplayContinuation, releaseAutoplayContinuation, hasAutoplayContinuationBeenUsed }

// Read-only session field accessors for adapter layers. The implementations
// live in sessionAccessors.js (a leaf module) because adapters like
// recommendFlow/permissions can't import sessions.js without a circular
// import — sessions.js already imports them. Re-exported here so they remain
// part of this module's public surface.
export {
  sessionVoiceChannelId,
  sessionVoiceGuildId,
  sessionConnectionStatus,
  sessionPlanToken,
  isSessionStale,
} from './sessionAccessors.js'

export async function getOrCreateSession({ guildId, guild, channel, textChannelId = null, recommendHooks }) {
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

  // Adapter-supplied recommendation functions (see NOOP_RECOMMEND_HOOKS).
  // Stored on the session so onDisconnect/destroySession/playbackFor's
  // onStop can reach them through the sessions Map, and passed into the
  // queue-exhaustion handler config below.
  const hooks = { ...NOOP_RECOMMEND_HOOKS, ...recommendHooks }

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
      hooks.cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
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
    playback,
    getSession: () => sessions.get(guildId),
    onDisconnect,
    webClient,
    recommendPendingStore,
    recommendRounds,
    recommendHooks: hooks,
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
  session = { guildId, connection, player, queue, textChannelId: textChannelId ?? channel.id, planToken: 0, autoplayContinuationUsed: false, recentPlayedVideoIds: [], recommendHooks: hooks }
  sessions.set(guildId, session)
  return session
}
