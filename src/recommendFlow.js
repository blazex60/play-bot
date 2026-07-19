import { ActionRowBuilder, EmbedBuilder, MessageFlags } from 'discord.js'
import { buildChoiceComponents, parseChoiceCustomId } from './views.js'

export const RECOMMEND_CUSTOM_ID_PREFIX = 'autoplay'
const RECOMMEND_TIMEOUT_MS = 5 * 60 * 1000

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
// Used both when one user's pick wins (the rest lose) and when the session
// is torn down (VC empty, /stop, watchdog) while recommendations are open.
export function cancelRecommendations(guildId, pendingStore) {
  for (const [messageId, entry] of pendingStore.entries()) {
    if (entry.guildId !== guildId) continue
    clearTimeout(entry.timeoutHandle)
    pendingStore.delete(messageId)
    disableMessage(entry.message).catch(() => {})
  }
}

export async function postRecommendations({ client, channel, guildId, plans, pendingStore, onTimeout }) {
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
  }
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

  clearTimeout(entry.timeoutHandle)
  pendingStore.delete(interaction.message.id)

  const session = sessions.get(entry.guildId)
  if (!session) {
    return interaction.reply({ content: '❌ セッションが終了しています', flags: MessageFlags.Ephemeral })
  }

  await interaction.deferUpdate()
  session.queue.add(track)
  await session.player.playNext()
  await disableMessage(interaction.message).catch(() => {})

  cancelRecommendations(entry.guildId, pendingStore)
}
