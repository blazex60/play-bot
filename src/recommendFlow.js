import { ActionRowBuilder, EmbedBuilder, MessageFlags } from 'discord.js'
import { buildChoiceComponents, parseChoiceCustomId } from './views.js'
import { checkInVoiceChannel } from './permissions.js'
import { createTrack } from './queue.js'

export const RECOMMEND_CUSTOM_ID_PREFIX = 'autoplay'
const RECOMMEND_TIMEOUT_MS = 5 * 60 * 1000

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

// Cancels every still-pending recommendation message for a guild: clears
// timeouts, drops the pendingStore entries, and disables the posted buttons.
// Used when the session is torn down (VC empty, /stop, watchdog) while
// recommendations are open. A single user picking their own recommendation
// does NOT go through this — each listener's prompt is independent, so one
// person's pick must not disable anyone else's.
export function cancelRecommendations(guildId, pendingStore) {
  for (const [messageId, entry] of pendingStore.entries()) {
    if (entry.guildId !== guildId) continue
    clearTimeout(entry.timeoutHandle)
    pendingStore.delete(messageId)
    disableMessage(entry.message).catch(() => {})
  }
}

// Returns the number of recommendation messages actually posted, so callers
// can tell "posted but nobody has picked yet" apart from "every send failed"
// (e.g. the remembered text channel was deleted or the bot lost permission).
export async function postRecommendations({ client, channel, guildId, plans, pendingStore, onTimeout }) {
  let postedCount = 0

  for (const { userId, candidates } of plans) {
    if (!candidates.length) continue

    const embed = new EmbedBuilder()
      .setTitle('🎵 次の曲のおすすめ')
      .setDescription(
        `<@${userId}> さん、次に聴きたい曲を選んでください:\n` +
        candidates.map((track, i) => `${i + 1}. ${track.title}`).join('\n')
      )

    const components = buildChoiceComponents(candidates, {
      prefix: RECOMMEND_CUSTOM_ID_PREFIX,
      getLabel: (track) => track.title,
    })

    let message
    try {
      message = await channel.send({ embeds: [embed], components })
    } catch (err) {
      console.error('[recommendFlow] failed to post recommendation:', err.message)
      continue
    }

    const entry = { guildId, targetUserId: userId, candidates, message, timeoutHandle: null }
    entry.timeoutHandle = setTimeout(async () => {
      pendingStore.delete(message.id)
      await disableMessage(message).catch(() => {})
      if (!hasPendingForGuild(pendingStore, guildId) && onTimeout) {
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
  // The target user may have left the VC after the prompt was posted while
  // other listeners kept the session alive; re-check membership the same way
  // every other playback-affecting command does before honoring the pick.
  // Checked before consuming the entry so a legitimate click still works if
  // they rejoin and try again, instead of silently expiring the prompt.
  if (!checkInVoiceChannel(interaction, session)) return

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

  await interaction.deferUpdate()
  // Mirror /play's search flow: the picked prompt is single-use, so remove it
  // instead of leaving it around disabled like the other candidates' prompts.
  try {
    await entry.message.delete()
  } catch {
    // Already gone, or the bot lacks permission — not worth failing the pick over.
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
}
