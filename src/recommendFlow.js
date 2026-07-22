import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js'
import { buildChoiceComponents, parseChoiceCustomId } from './views.js'
import { checkCommandAllowed, checkInVoiceChannel } from './permissions.js'
import { createTrack } from './queue.js'

export const RECOMMEND_CUSTOM_ID_PREFIX = 'autoplay'
export const RECOMMEND_SHOW_CUSTOM_ID = 'recommend-show'
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

export function hasPendingForGuild(pendingStore, guildId) {
  for (const [, entry] of pendingStore.entries()) {
    if (entry.guildId === guildId) return true
  }
  return false
}

// A repeated round (someone's pick finished quickly while another user's
// ephemeral prompt from an earlier round is still open) must not stack a
// second ephemeral prompt on top of a user's still-unanswered one.
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

// Reserves a (guildId, userId) pair from the synchronous instant a "show
// recommendations" click passes its checks until the resulting ephemeral
// message is either registered in pendingStore or discarded. Without this,
// two rapid clicks both race past hasPendingForUser (which only sees
// pendingStore, populated only after the reply/fetchReply awaits) and both
// create a live pick for the same user.
const showInFlight = new Set()

function reserveShow(guildId, userId) {
  const key = `${guildId}:${userId}`
  if (showInFlight.has(key)) return false
  showInFlight.add(key)
  return true
}

function releaseShow(guildId, userId) {
  showInFlight.delete(`${guildId}:${userId}`)
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
// The shared round itself (recommendRounds) must also be checked, not just
// per-user ephemeral picks — a failed pick can otherwise fire onTimeout
// early while the round's own button is still live with minutes left and
// other participants who haven't clicked "show" yet could still use it.
async function reconsiderTeardown(guildId, pendingStore, recommendRounds) {
  if (hasPendingForGuild(pendingStore, guildId) || hasInFlightPick(guildId)) return
  if (recommendRounds?.get(guildId)) return
  const onTimeout = guildOnTimeoutCallbacks.get(guildId)
  if (!onTimeout) return
  try {
    await onTimeout()
  } catch (err) {
    console.error('[recommendFlow] onTimeout failed:', err.message)
  }
}

// Bumped by cancelRecommendations so postRecommendationPrompt can notice,
// right after channel.send() resolves, that the guild's session was torn
// down while that send was still in flight.
const guildCancelGeneration = new Map()

function bumpCancelGeneration(guildId) {
  guildCancelGeneration.set(guildId, (guildCancelGeneration.get(guildId) ?? 0) + 1)
}

function currentCancelGeneration(guildId) {
  return guildCancelGeneration.get(guildId) ?? 0
}

// Clears a round's own timer, drops it from recommendRounds, and disables
// its shared button. A round's timer must never fire after this — since the
// timer closes over this specific entry and unconditionally deletes
// recommendRounds's guildId key, letting it fire later would delete
// whatever round has since replaced this one.
function retireRound(guildId, recommendRounds) {
  const round = recommendRounds.get(guildId)
  if (!round) return
  clearTimeout(round.timeoutHandle)
  recommendRounds.delete(guildId)
  disableMessage(round.message).catch(() => {})
}

// Cancels a guild's still-open recommendation round: retires the shared
// "show" prompt (see retireRound) and clears every still-pending per-user
// ephemeral pick prompt for the guild (those are left as-is rather than
// edited — they're ephemeral so only their own owner can see them, and a
// stale click on one is already rejected once its pendingStore entry is
// gone). Used when the session is torn down (VC empty, /stop, watchdog)
// while recommendations are open.
export function cancelRecommendations(guildId, pendingStore, recommendRounds) {
  bumpCancelGeneration(guildId)
  for (const [messageId, entry] of pendingStore.entries()) {
    if (entry.guildId !== guildId) continue
    clearTimeout(entry.timeoutHandle)
    pendingStore.delete(messageId)
  }
  if (recommendRounds) retireRound(guildId, recommendRounds)
}

// Arms a per-user ephemeral pick prompt's one-shot expiry timer. Unlike the
// shared round message, this isn't visually disabled on expiry — it's
// ephemeral, so only its owner can see or click it, and a click on it once
// this fires simply finds no pendingStore entry and gets the "期限切れ"
// reply (see handleRecommendChoice), which is enough for correctness.
function scheduleExpiry(entry, pendingStore, guildId, onTimeout) {
  entry.timeoutHandle = setTimeout(async () => {
    entry.expired = true
    pendingStore.delete(entry.message.id)
    if (!hasPendingForGuild(pendingStore, guildId) && !hasInFlightPick(guildId) && onTimeout) {
      try {
        await onTimeout()
      } catch (err) {
        console.error('[recommendFlow] onTimeout failed:', err.message)
      }
    }
  }, RECOMMEND_TIMEOUT_MS)
}

// Arms the shared round message's one-shot expiry timer: disables its
// button (it's a normal, non-ephemeral message, so editing it is safe) and
// drops it from recommendRounds. Nobody having picked anything by then only
// tears the session down if no per-user ephemeral prompt is still open and
// no pick is in flight — mirrors scheduleExpiry's own condition.
function scheduleRoundExpiry(entry, recommendRounds, pendingStore, guildId, onTimeout) {
  entry.timeoutHandle = setTimeout(async () => {
    entry.expired = true
    recommendRounds.delete(guildId)
    await disableMessage(entry.message).catch(() => {})
    if (!hasPendingForGuild(pendingStore, guildId) && !hasInFlightPick(guildId) && onTimeout) {
      try {
        await onTimeout()
      } catch (err) {
        console.error('[recommendFlow] onTimeout failed:', err.message)
      }
    }
  }, RECOMMEND_TIMEOUT_MS)
}

// Posts a single shared "おすすめを表示" prompt to the VC's linked text
// channel, usable by every user who was in the VC at planning time (the
// userIds present in `plans`). Returns 1 if the prompt was posted, 0 if
// there was nobody to show it to or the send failed — sessions.js uses this
// the same way postRecommendations' return value used to be used.
export async function postRecommendationPrompt({ channel, guildId, guildName, plans, recommendRounds, pendingStore, onTimeout }) {
  const candidatesByUserId = new Map()
  for (const { userId, candidates } of plans) {
    if (candidates.length) candidatesByUserId.set(userId, candidates)
  }
  if (candidatesByUserId.size === 0) return 0
  if (onTimeout) guildOnTimeoutCallbacks.set(guildId, onTimeout)

  const startGeneration = currentCancelGeneration(guildId)

  const embed = new EmbedBuilder()
    .setTitle(`🎵 ${guildName ?? 'サーバー'} の次の曲のおすすめができました`)
    .setDescription('ボタンを押すと、あなた専用のおすすめが表示されます（表示時点でボイスチャンネルにいた人が対象です）')

  const button = new ButtonBuilder()
    .setCustomId(RECOMMEND_SHOW_CUSTOM_ID)
    .setLabel('おすすめを表示')
    .setStyle(ButtonStyle.Primary)
  const components = [new ActionRowBuilder().addComponents(button)]

  let message
  try {
    message = await channel.send({ embeds: [embed], components })
  } catch (err) {
    console.error('[recommendFlow] failed to post recommendation prompt:', err.message)
    return 0
  }

  if (currentCancelGeneration(guildId) !== startGeneration) {
    // The session was torn down (e.g. /stop) while this send was still in
    // flight. Don't leave this fresh message as a live, pickable prompt.
    disableMessage(message).catch(() => {})
    return 0
  }

  // A previous round for this guild can still be open here (e.g. someone
  // picked a short track from it and playback already exhausted again before
  // its own 5-minute window elapsed) — retire it now so its timer can never
  // fire later and delete this new round out from under it.
  retireRound(guildId, recommendRounds)

  const entry = { guildId, candidatesByUserId, message, timeoutHandle: null, expired: false }
  scheduleRoundExpiry(entry, recommendRounds, pendingStore, guildId, onTimeout)
  recommendRounds.set(guildId, entry)
  return 1
}

// Handles a click on the shared "おすすめを表示" button: looks up the
// clicking user's candidates from the round's snapshot (taken when the
// round was planned) and shows them an ephemeral, personal choice prompt.
// Live VC membership isn't re-checked here by design — the shared button is
// meant for whoever was actually in the room when the round was planned.
export async function handleShowRecommendations(interaction, sessions, recommendRounds, pendingStore) {
  const round = recommendRounds.get(interaction.guildId)
  if (!round || round.expired) {
    return interaction.reply({ content: '❌ この提案は期限切れです', flags: MessageFlags.Ephemeral })
  }
  if (!sessions.get(interaction.guildId)) {
    return interaction.reply({ content: '❌ セッションが終了しています', flags: MessageFlags.Ephemeral })
  }
  if (!checkCommandAllowed(interaction, process.env.ADMIN_ROLE_ID, 'play', interaction.guildId, interaction.member)) {
    return
  }

  const candidates = round.candidatesByUserId.get(interaction.user.id)
  if (!candidates) {
    return interaction.reply({ content: '❌ 現在あなた向けのおすすめはありません', flags: MessageFlags.Ephemeral })
  }
  if (hasPendingForUser(pendingStore, interaction.guildId, interaction.user.id)) {
    return interaction.reply({ content: '⚠️ 既におすすめを表示済みです。そちらから選択してください', flags: MessageFlags.Ephemeral })
  }
  // Reserve synchronously, before any await below — hasPendingForUser alone
  // can't see a second, near-simultaneous click for the same user, since
  // pendingStore isn't populated until after interaction.reply/fetchReply
  // resolve further down.
  if (!reserveShow(interaction.guildId, interaction.user.id)) {
    return interaction.reply({ content: '⚠️ 既におすすめを表示済みです。そちらから選択してください', flags: MessageFlags.Ephemeral })
  }

  try {
    // /stop, /leave, or the VC emptying out can land while the awaits below
    // are in flight; cancelPendingRecommendations can't clear this entry
    // since it isn't in pendingStore yet, so check afterward instead.
    const startGeneration = currentCancelGeneration(interaction.guildId)

    const embed = new EmbedBuilder()
      .setTitle('🎵 次に聴きたい曲を選んでください')
      .setDescription(candidates.map((track, i) => `${i + 1}. ${track.title}`).join('\n'))

    const components = buildChoiceComponents(candidates, {
      prefix: RECOMMEND_CUSTOM_ID_PREFIX,
      getLabel: (track) => track.title,
    })

    await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral })
    const message = await interaction.fetchReply()

    if (currentCancelGeneration(interaction.guildId) !== startGeneration) {
      // The session was cancelled (/stop, /leave, VC emptied) while this
      // reply was in flight — don't leave a fresh, pickable prompt on top
      // of a session that was just stopped.
      await interaction.deleteReply().catch(() => {})
      return
    }

    const entry = { guildId: interaction.guildId, targetUserId: interaction.user.id, candidates, message, timeoutHandle: null, expired: false }
    scheduleExpiry(entry, pendingStore, interaction.guildId, guildOnTimeoutCallbacks.get(interaction.guildId))
    pendingStore.set(message.id, entry)
  } finally {
    releaseShow(interaction.guildId, interaction.user.id)
  }
}

export async function handleRecommendChoice(interaction, sessions, pendingStore, recommendRounds) {
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
  // watchdog) landing during the awaits below.
  const planTokenAtClaim = session.planToken
  const isSessionStale = () => sessions.get(entry.guildId) !== session || session.planToken !== planTokenAtClaim

  // Claim this user's own prompt synchronously, before ANY await — a double
  // click on the same message would otherwise both read this same entry and
  // both proceed to queue.add, enqueueing the track twice. Node never
  // interleaves another interaction handler's synchronous prefix with this
  // one, so whichever handler reaches this line first wins; a second
  // handler for the same message will find entry.get() already gone at the
  // top of this function. Other users' prompts are untouched.
  pendingStore.delete(interaction.message.id)
  // Held until the chosen track is actually enqueued below (or this pick
  // bails out), so another still-live prompt's timeout can't decide "nothing
  // pending, tear the session down" while this pick is mid-flight.
  markPickInFlight(entry.guildId)

  try {
    // A denied 'play' permission must block this pick too — otherwise an
    // admin's denial is bypassed entirely through recommendation picks,
    // which dispatch here instead of through index.js's chat-input-command
    // guard.
    if (!checkCommandAllowed(interaction, process.env.ADMIN_ROLE_ID, 'play', entry.guildId, interaction.member)) {
      if (!isSessionStale() && !entry.expired) {
        pendingStore.set(interaction.message.id, entry)
      }
      return
    }
    // The picker may have left the bot's VC after their ephemeral prompt was
    // shown — the "show" step only checks the planning-time snapshot, but
    // actually enqueueing/starting playback must reflect who's in the room
    // right now, same as every other playback-affecting command.
    if (!(await checkInVoiceChannel(interaction, session))) {
      if (!isSessionStale() && !entry.expired) {
        pendingStore.set(interaction.message.id, entry)
      }
      return
    }
    clearTimeout(entry.timeoutHandle)

    // Acknowledge the interaction, then remove the ephemeral prompt itself —
    // the picked prompt is single-use, so it must disappear once answered,
    // mirroring /play's search flow (which deletes its picked message too).
    await interaction.deferUpdate()
    await interaction.deleteReply().catch(() => {})

    if (isSessionStale()) {
      // /stop or a disconnect landed while deferUpdate()/deleteReply() were
      // in flight; the session this pick read is gone or was reset, so
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
    await reconsiderTeardown(entry.guildId, pendingStore, recommendRounds)
  }
}
