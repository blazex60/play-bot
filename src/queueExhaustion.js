import { getGuildSettings } from './settings.js'
import { planAutoTrack, planRecommendations, formatAutoAddNotification } from './autoplay.js'
import { cancelRecommendations, hasPendingForGuild, postRecommendationPrompt } from './recommendFlow.js'

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

// Builds a guild's queue-exhaustion continuation (autoplay/recommend-mode)
// handler. Pulled out of sessions.js so that file can stay a simple shared
// VC-session-state hub instead of hosting this policy inline — getSession is
// a thunk (rather than importing sessions.js's own `sessions` Map directly)
// so this module never depends on sessions.js, keeping the import graph
// one-directional. See sessions.js's getOrCreateSession for how guildId,
// guild, connection, queue, onDisconnect, webClient, recommendPendingStore,
// and recommendRounds are wired in.
export function createQueueExhaustionHandler({
  guildId,
  guild,
  connection,
  queue,
  getSession,
  onDisconnect,
  webClient,
  recommendPendingStore,
  recommendRounds,
}) {
  const handleQueueExhausted = async (lastTrack) => {
    const session = getSession()
    if (!session) return false
    // null (not false) means "someone else is already running a round for
    // this guild" — distinct from a round that ran and genuinely found
    // nothing to do. Two DM prompts from the same round expire within
    // microtasks of each other in the common case (nobody answers), so both
    // per-message timeouts can call onTimeout at nearly the same time; the
    // caller must not treat "the other one already grabbed this" as failure
    // and disconnect out from under the round that's actually in progress.
    if (!claimAutoplayContinuation(session)) return null
    // planAutoTrack/planRecommendations do multi-second async work (history
    // fetch, yt-dlp). /stop can clear the queue in that window without
    // deleting the session, which would otherwise make queue.isEmpty look
    // "still idle" again and let this continuation undo the stop. planToken
    // is bumped on /stop so a stale continuation can tell it happened.
    const planToken = session.planToken
    const isStale = () => getSession() !== session || session.planToken !== planToken

    try {
      const voiceChannel = guild.channels.cache.get(connection.joinConfig.channelId)
      if (!voiceChannel) return false

      const autoTrack = await planAutoTrack({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient, recentVideoIds: session.recentPlayedVideoIds })
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

      const plans = await planRecommendations({ guildId, guild, channel: voiceChannel, queue, lastTrack, webClient, recentVideoIds: session.recentPlayedVideoIds })
      if (isStale()) return false
      if (plans && plans.length > 0) {
        const textChannel = session.textChannelId ? guild.channels.cache.get(session.textChannelId) : null
        const postedCount = textChannel
          ? await postRecommendationPrompt({
              channel: textChannel,
              guildId,
              guildName: guild.name,
              plans,
              recommendRounds,
              pendingStore: recommendPendingStore,
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
                // continued === null means another overlapping timeout already
                // claimed the lock and is handling this round itself; only a
                // genuine `false` (a round that ran and found nothing to do)
                // should tear the session down here.
                if (continued === false) await onDisconnect()
              },
            })
          : 0
        if (isStale()) {
          // /stop (or similar) can land while the send was still in flight
          // above: the message already got posted with a live button before
          // we knew to cancel it. Undo that now rather than leaving a
          // pickable prompt that could revive playback post-stop.
          cancelRecommendations(guildId, recommendPendingStore, recommendRounds)
          return false
        }
        if (postedCount > 0) return true
      }

      // This round may have posted nothing new — e.g. planning found no
      // candidates this time, or posting a replacement failed — while an
      // earlier round's shared button (or someone's personal pick prompt
      // from it) is still live and answerable. Treat that as a handled
      // exhaustion instead of falling through to onDisconnect and cancelling
      // a prompt someone can still pick.
      if (hasPendingForGuild(recommendPendingStore, guildId) || recommendRounds.has(guildId)) return true

      return false
    } finally {
      releaseAutoplayContinuation(session)
    }
  }

  return handleQueueExhausted
}
