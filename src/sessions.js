import { joinVoiceChannel, VoiceConnectionStatus, entersState } from '@discordjs/voice'
import { GuildQueue } from './queue.js'
import { GuildPlayer } from './player.js'
import { PendingChoiceStore } from './views.js'
import { createWebClient } from './webClient.js'
import { planAutoTrack, planRecommendations, formatAutoAddNotification } from './autoplay.js'
import { cancelRecommendations, hasPendingForGuild, postRecommendations } from './recommendFlow.js'
import { getGuildSettings } from './settings.js'

// Map<guildId, { guildId, connection, player, queue, textChannelId, planToken, autoplayContinuationUsed }>
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

// Invalidates any queue-exhaustion planning currently in flight for a guild.
// Call this whenever something changes state that in-flight planning already
// read before its first await — stopping playback, or flipping autoplayMode/
// personalize — so a stale continuation can't act on outdated assumptions.
export function bumpPlanToken(guildId) {
  const session = sessions.get(guildId)
  if (session) session.planToken += 1
}

// This is a re-entrancy lock for a single in-flight queue-exhaustion round,
// not a "used up" marker: it's claimed at the start of handleQueueExhausted
// and always released once that round's planning/posting settles (success
// or failure), so the next queue-exhaustion event can claim it again. Autoplay
// and recommend mode both keep continuing for as long as the session (i.e.
// the bot's current VC connection) lives — only /leave or the VC emptying
// out ends it.
export function hasAutoplayContinuationBeenUsed(session) {
  return session?.autoplayContinuationUsed === true
}

export function claimAutoplayContinuation(session) {
  if (!session || session.autoplayContinuationUsed === true) return false
  session.autoplayContinuationUsed = true
  return true
}

export function releaseAutoplayContinuation(session) {
  if (session) session.autoplayContinuationUsed = false
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
      cancelRecommendations(guildId, recommendPendingStore)
      if (s.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        s.connection.destroy()
      }
    }
  }

  const handleQueueExhausted = async (lastTrack) => {
    const session = sessions.get(guildId)
    if (!session) return false
    if (!claimAutoplayContinuation(session)) return false
    // planAutoTrack/planRecommendations do multi-second async work (history
    // fetch, yt-dlp). /stop can clear the queue in that window without
    // deleting the session, which would otherwise make queue.isEmpty look
    // "still idle" again and let this continuation undo the stop. planToken
    // is bumped on /stop so a stale continuation can tell it happened.
    const planToken = session.planToken
    const isStale = () => sessions.get(guildId) !== session || session.planToken !== planToken

    try {
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
        if (getGuildSettings(guildId).autoNotify === true) {
          const textChannelId = session.textChannelId
          const textChannel = textChannelId ? guild.channels.cache.get(textChannelId) : null
          if (textChannel) {
            await textChannel.send(formatAutoAddNotification(autoTrack)).catch((err) => {
              console.error('[sessions] failed to post autoplay notification:', err.message)
            })
          }
        }
        return true
      }

      const plans = await planRecommendations({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient })
      if (isStale()) return false
      if (plans && plans.length > 0) {
        const postedCount = await postRecommendations({
          client: guild.client,
          guildId,
          guildName: guild.name,
          plans,
          queue,
          player: session.player,
          pendingStore: recommendPendingStore,
          voiceChannel,
          onTimeout: async () => {
            // A manual /play may have started a track while this prompt sat
            // unanswered — only end the session if nothing is actually
            // playing/queued and this round is still the live one.
            if (!queue.isEmpty || isStale()) return
            // Nobody picked anything: keep the bot in the VC and show a
            // fresh round (current VC membership, current preferences)
            // instead of disconnecting. Only /leave or the VC emptying out
            // should end the session now — see handleQueueExhausted's own
            // lock release below, which is what makes this re-entry legal.
            const continued = await handleQueueExhausted(lastTrack)
            if (!continued) await onDisconnect()
          },
        })
        if (isStale()) {
          // /stop (or similar) can land while sends were still in flight
          // above: the messages already got posted with live buttons before
          // we knew to cancel them. Undo that now rather than leaving a
          // pickable prompt that could revive playback post-stop.
          cancelRecommendations(guildId, recommendPendingStore)
          return false
        }
        if (postedCount > 0) return true
      }

      // This round may have posted nothing new — e.g. the only human left in
      // the VC already had a live DM from an earlier round and got skipped
      // by postRecommendations' own dedup — while that earlier DM is still a
      // perfectly valid, answerable prompt. Treat that as a handled
      // exhaustion instead of falling through to onDisconnect and cancelling
      // a prompt someone can still pick.
      if (hasPendingForGuild(recommendPendingStore, guildId)) return true

      return false
    } finally {
      releaseAutoplayContinuation(session)
    }
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
  session = { guildId, connection, player, queue, textChannelId: textChannelId ?? channel.id, planToken: 0, autoplayContinuationUsed: false }
  sessions.set(guildId, session)
  return session
}
