import { ActionRowBuilder, EmbedBuilder, MessageFlags } from 'discord.js'
import { buildChoiceComponents, parseChoiceCustomId } from './views.js'
import { checkInVoiceChannel } from './permissions.js'
import { createTrack } from './queue.js'

export const RECOMMEND_CUSTOM_ID_PREFIX = 'autoplay'
export const RECOMMEND_TIMEOUT_MS = 5 * 60 * 1000

export function fmtDuration(seconds) {
  if (seconds == null) return '不明'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

async function disableMessage(message) {
  const disabledRows = message.components.map((row) => {
    const builder = ActionRowBuilder.from(row)
    builder.components.forEach((component) => component.setDisabled(true))
    return builder
  })
  await message.edit({ components: disabledRows })
}

function hasPendingForGuild(pendingStore, guildId) {
  for (const [, entry] of pendingStore.entries()) {
    if (entry.guildId === guildId) return true
  }
  return false
}

// A repeated round (someone's pick finished quickly while others' prompts
// from an earlier round are still live) must not stack a second DM on top
// of a user's still-unanswered one.
function hasPendingForUser(pendingStore, guildId, userId) {
  for (const [, entry] of pendingStore.entries()) {
    if (entry.guildId === guildId && entry.targetUserId === userId) return true
  }
  return false
}

// Guilds with a pick currently being processed, from the moment
// handleRecommendChoice claims its prompt until the chosen track has been
// enqueued. Prompts are independent now, so another user's prompt can still
// be live and time out while this one is mid-flight; without this guard,
// that timeout's "nothing left pending" check would race the in-flight pick
// and could tear the session down before its track is actually queued.
const guildsWithInFlightPick = new Map()

function markPickInFlight(guildId) {
  guildsWithInFlightPick.set(guildId, (guildsWithInFlightPick.get(guildId) ?? 0) + 1)
}

function clearPickInFlight(guildId) {
  const remaining = (guildsWithInFlightPick.get(guildId) ?? 0) - 1
  if (remaining > 0) guildsWithInFlightPick.set(guildId, remaining)
  else guildsWithInFlightPick.delete(guildId)
}

function hasInFlightPick(guildId) {
  return (guildsWithInFlightPick.get(guildId) ?? 0) > 0
}

// The onTimeout callback most recently registered for a guild's recommend
// round, so a pick that finishes (or fails) after the round's own prompts
// have all already expired can still trigger it — see reconsiderTeardown.
const guildOnTimeoutCallbacks = new Map()

// Re-runs the same "nothing left pending for this guild" teardown decision a
// prompt's own timeout would have made, for the case where that timeout
// already fired and deferred to an in-flight pick (via hasInFlightPick)
// that then finishes without ever calling queue.add — e.g. deferUpdate()
// rejects, or the interaction handler throws before enqueueing. Without
// this, nothing would ever re-check afterward and the session would stay
// connected with an empty queue indefinitely. Safe to call unconditionally:
// onTimeout itself no-ops once the queue is non-empty or the plan is stale.
async function reconsiderTeardown(guildId, pendingStore) {
  if (hasPendingForGuild(pendingStore, guildId) || hasInFlightPick(guildId)) return
  const onTimeout = guildOnTimeoutCallbacks.get(guildId)
  if (!onTimeout) return
  try {
    await onTimeout()
  } catch (err) {
    console.error('[recommendFlow] onTimeout failed:', err.message)
  }
}

// Bumped by cancelRecommendations so postRecommendations can notice, right
// after a channel.send() resolves, that the guild's session was torn down
// while that send was still in flight.
const guildCancelGeneration = new Map()

function bumpCancelGeneration(guildId) {
  guildCancelGeneration.set(guildId, (guildCancelGeneration.get(guildId) ?? 0) + 1)
}

function currentCancelGeneration(guildId) {
  return guildCancelGeneration.get(guildId) ?? 0
}

// Cancels every still-pending recommendation message for a guild: clears
// timeouts, drops the pendingStore entries, and disables the posted buttons.
// Used when the session is torn down (VC empty, /stop, watchdog) while
// recommendations are open. A single user picking their own recommendation
// does NOT go through this — each listener's prompt is independent, so one
// person's pick must not disable anyone else's.
export function cancelRecommendations(guildId, pendingStore) {
  bumpCancelGeneration(guildId)
  for (const [messageId, entry] of pendingStore.entries()) {
    if (entry.guildId !== guildId) continue
    clearTimeout(entry.timeoutHandle)
    pendingStore.delete(messageId)
    disableMessage(entry.message).catch(() => {})
  }
}

// Returns the number of recommendation messages actually posted, so callers
// can tell "posted but nobody has picked yet" apart from "every send failed"
// (e.g. everyone's DMs are closed to the bot).
export async function postRecommendations({ client, guildId, guildName, plans, pendingStore, onTimeout, voiceChannel }) {
  let postedCount = 0
  const startGeneration = currentCancelGeneration(guildId)
  if (onTimeout) guildOnTimeoutCallbacks.set(guildId, onTimeout)

  for (const { userId, candidates } of plans) {
    if (!candidates.length) continue
    // Planning (history fetch, yt-dlp lookups) and the sequential sends
    // above this plan in the loop can together take long enough for this
    // user to have already left the VC; re-check live membership right
    // before posting instead of trusting the snapshot planRecommendations
    // took at the start, so a prompt for "the room you just left" doesn't
    // show up after the fact.
    if (voiceChannel && !voiceChannel.members.has(userId)) continue
    // Recommend mode now loops for as long as the session lives, so a fast
    // pick by one user can trigger a fresh round while another user's prompt
    // from the previous round is still open. Don't stack a second DM on top
    // of it — let their existing prompt run its course first.
    if (hasPendingForUser(pendingStore, guildId, userId)) continue

    const embed = new EmbedBuilder()
      .setTitle(`🎵 ${guildName ?? 'サーバー'} の次の曲のおすすめ`)
      .setDescription(
        '次に聴きたい曲を選んでください:\n' +
        candidates.map((track, i) => `${i + 1}. ${track.title}`).join('\n')
      )

    const components = buildChoiceComponents(candidates, {
      prefix: RECOMMEND_CUSTOM_ID_PREFIX,
      getLabel: (track) => track.title,
    })

    let message
    try {
      const user = await client.users.fetch(userId)
      message = await user.send({ embeds: [embed], components })
    } catch (err) {
      console.error('[recommendFlow] failed to DM recommendation:', err.message)
      continue
    }

    if (currentCancelGeneration(guildId) !== startGeneration) {
      // The session was torn down (e.g. /stop) while this send was still in
      // flight, after cancelRecommendations already swept whatever was in
      // pendingStore. Don't leave this fresh message as a live, pickable
      // prompt, and don't bother posting to the rest of the plans either.
      disableMessage(message).catch(() => {})
      break
    }

    const entry = { guildId, targetUserId: userId, candidates, message, timeoutHandle: null }
    entry.timeoutHandle = setTimeout(async () => {
      pendingStore.delete(message.id)
      await disableMessage(message).catch(() => {})
      if (!hasPendingForGuild(pendingStore, guildId) && !hasInFlightPick(guildId) && onTimeout) {
        try {
          await onTimeout()
        } catch (err) {
          console.error('[recommendFlow] onTimeout failed:', err.message)
        }
      }
    }, RECOMMEND_TIMEOUT_MS)

    pendingStore.set(message.id, entry)
    postedCount += 1
  }
  return postedCount
}

export async function handleRecommendChoice(interaction, sessions, pendingStore) {
  const index = parseChoiceCustomId(interaction.customId, RECOMMEND_CUSTOM_ID_PREFIX)
  if (index === null) return

  const entry = pendingStore.get(interaction.message.id)
  if (!entry) {
    return interaction.reply({ content: '❌ このおすすめは期限切れです', flags: MessageFlags.Ephemeral })
  }
  if (interaction.user.id !== entry.targetUserId) {
    return interaction.reply({ content: '❌ これはあなた宛のおすすめではありません', flags: MessageFlags.Ephemeral })
  }
  const track = entry.candidates[index]
  if (!track) return

  const session = sessions.get(entry.guildId)
  if (!session) {
    return interaction.reply({ content: '❌ セッションが終了しています', flags: MessageFlags.Ephemeral })
  }
  // Snapshot enough to detect /stop or a disconnect (VC empty, /leave,
  // watchdog) landing during the awaits below — same staleness pattern
  // handleQueueExhausted uses. markPickInFlight only stops THIS pick's own
  // guild from tearing itself down over "nothing pending"; it does nothing
  // to protect against an unrelated teardown that happens anyway while this
  // pick is mid-flight.
  const planTokenAtClaim = session.planToken
  const isSessionStale = () => sessions.get(entry.guildId) !== session || session.planToken !== planTokenAtClaim
  // The target user may have left the VC after the prompt was posted while
  // other listeners kept the session alive; re-check membership the same way
  // every other playback-affecting command does before honoring the pick.
  // Checked before consuming the entry so a legitimate click still works if
  // they rejoin and try again, instead of silently expiring the prompt.
  // Prompts are DMs now, so this click carries no guild/member context —
  // checkInVoiceChannel resolves the member itself in that case.
  if (!(await checkInVoiceChannel(interaction, session))) return

  // Claim this user's own prompt synchronously, before any await: a double
  // click on the same message in the same tick would otherwise pass every
  // check above twice, since neither invocation yields control until here.
  // Node never interleaves another interaction handler's synchronous prefix
  // with this one, so whichever handler reaches this line first wins; a
  // second handler for the same message will find entry.get() already gone
  // at the top of this function. Other users' prompts are untouched — each
  // listener's recommendation is independent, so this pick must not affect
  // anyone else's.
  clearTimeout(entry.timeoutHandle)
  pendingStore.delete(interaction.message.id)
  // Held until the chosen track is actually enqueued below, so another still-
  // live prompt's timeout can't decide "nothing pending, tear the session
  // down" while this pick is between claiming its entry and finishing.
  markPickInFlight(entry.guildId)

  try {
    await interaction.deferUpdate()
    // Mirror /play's search flow: the picked prompt is single-use, so remove it
    // instead of leaving it around disabled like the other candidates' prompts.
    try {
      await entry.message.delete()
    } catch {
      // Already gone, or the bot lacks permission — not worth failing the pick over.
    }

    if (isSessionStale()) {
      // /stop or a disconnect landed while deferUpdate()/message.delete()
      // were in flight; the session this pick read is gone or was reset, so
      // don't resurrect playback on top of it.
      await interaction.followUp({ content: '❌ セッションが終了しています', flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    // Recommendation candidates start with requestedById: null (they came from
    // the bot's own suggestion, not a request), which would make GuildPlayer
    // skip recording the play. Attribute it to the picker now so recommend-mode
    // picks actually feed back into that user's personalization history.
    const chosenTrack = createTrack({
      ...track,
      requestedBy: interaction.member?.displayName ?? interaction.user.username,
      requestedById: interaction.user.id,
    })
    const wasEmpty = session.queue.isEmpty
    session.queue.add(chosenTrack)
    // Same confirmation format as /play's search picker, so a recommend pick
    // reads identically to a manual search pick in the channel.
    await interaction.followUp(`✅ ${chosenTrack.requestedBy} がキューに追加しました: **${chosenTrack.title}** (${fmtDuration(chosenTrack.duration)})`)
    if (wasEmpty) await session.player.playNext()
  } finally {
    clearPickInFlight(entry.guildId)
    await reconsiderTeardown(entry.guildId, pendingStore)
  }
}
