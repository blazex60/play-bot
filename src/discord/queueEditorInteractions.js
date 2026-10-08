import { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js'
import { buildQueueEditorPayload } from './queueEditorView.js'
import { checkSameVoiceChannel, checkCommandAllowed } from './permissions.js'
import { playbackFor, webClient } from '../playback/sessions.js'
import { resolveAdminRoleId } from '../shared/settings.js'

// Queue-editor moves/removes mutate the same queue /queue itself does, so
// they're audited under the 'queue' action too — otherwise these edits would
// be invisible in the admin dashboard's operation log even though the
// equivalent dashboard queue actions are logged.
function logQueueOp(interaction, success, detail) {
  webClient.logOperation({
    guildId: interaction.guildId,
    discordUserId: interaction.user.id,
    username: interaction.user.username,
    source: 'command',
    action: 'queue',
    success,
    detail,
  })
}

// _r<rev> is the queue revision the message was rendered against (see
// GuildQueue#revision). It's optional so a pre-deploy message without it
// still parses — a missing revision can never match the live counter, so
// old mutating buttons resolve to the same 'stale' warning instead of a
// silent no-op.
const CUSTOM_ID_RE = /^(qedit_[a-z]+)_p(\d+)(?:_i(\d+))?(?:_r(\d+))?$/

function parseCustomId(customId) {
  const match = customId.match(CUSTOM_ID_RE)
  if (!match) return null
  const [, action, pageStr, indexStr, revisionStr] = match
  return {
    action,
    page: parseInt(pageStr, 10),
    selectedIndex: indexStr !== undefined ? parseInt(indexStr, 10) : null,
    revision: revisionStr !== undefined ? parseInt(revisionStr, 10) : null,
  }
}

// Stale-index and stale-revision rejections share the same response: swap
// the panel for a fresh render, warn the clicker ephemerally, and log the
// failed op.
async function rejectStaleSelection(interaction, playback, page, detail) {
  await interaction.update(buildQueueEditorPayload(playback.getState(interaction.guildId), { page, selectedIndex: null }))
  logQueueOp(interaction, false, detail)
  return interaction.followUp({ content: '⚠️ キューが変更されました。もう一度選択してください', flags: MessageFlags.Ephemeral })
}

export async function handleQueueEditorInteraction(interaction, sessions) {
  const parsed = parseCustomId(interaction.customId)
  if (!parsed) return
  const { action, page, revision } = parsed
  let { selectedIndex } = parsed

  const session = sessions.get(interaction.guildId)
  const playback = playbackFor(sessions)

  // The editor's buttons/select/modal all act on the queue (or navigate a
  // view of it), so they're gated by the same 'queue' command permission as
  // /queue itself — otherwise a user denied /queue could still reach these
  // actions through an editor message that's already on screen. This
  // includes qedit_close: when /queue is public, the panel is visible to
  // (and clickable by) anyone in the channel, not just its original poster,
  // so a denied user must not be able to dismiss someone else's panel either.
  if (!checkCommandAllowed(interaction, resolveAdminRoleId(interaction.guildId), 'queue')) return

  if (interaction.isButton() && action === 'qedit_close') {
    if (!checkSameVoiceChannel(interaction, session)) return
    await interaction.deferUpdate()
    return interaction.message.delete().catch(() => {})
  }

  if (!session || playback.queueIsEmpty(interaction.guildId)) {
    return interaction.reply({ content: '📭 キューは空です', flags: MessageFlags.Ephemeral })
  }

  if (!checkSameVoiceChannel(interaction, session)) return

  if (interaction.isStringSelectMenu() && action === 'qedit_select') {
    // Values are `${index}:r${revision}` — read-only re-render, so only the
    // index matters (parseInt stops at ':'; pre-deploy plain indexes too).
    selectedIndex = parseInt(interaction.values[0], 10)
    return interaction.update(buildQueueEditorPayload(playback.getState(interaction.guildId), { page, selectedIndex }))
  }

  if (interaction.isButton() && action === 'qedit_page') {
    return interaction.update(buildQueueEditorPayload(playback.getState(interaction.guildId), { page, selectedIndex: null }))
  }

  if (interaction.isButton() && (action === 'qedit_moveup' || action === 'qedit_movedown' || action === 'qedit_tofront')) {
    const len = playback.getState(interaction.guildId).upcoming.length
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= len) {
      return rejectStaleSelection(interaction, playback, page, 'stale_index')
    }
    const toIndex = action === 'qedit_moveup' ? selectedIndex - 1
      : action === 'qedit_movedown' ? selectedIndex + 1
      : 0
    const moved = playback.moveUpcomingIfRevision(interaction.guildId, selectedIndex, toIndex, revision)
    if (moved === 'stale') {
      return rejectStaleSelection(interaction, playback, page, 'stale_revision')
    }
    logQueueOp(interaction, moved, JSON.stringify({ action, fromIndex: selectedIndex, toIndex }))
    return interaction.update(buildQueueEditorPayload(playback.getState(interaction.guildId), { page, selectedIndex: moved ? toIndex : selectedIndex }))
  }

  if (interaction.isButton() && action === 'qedit_remove') {
    const len = playback.getState(interaction.guildId).upcoming.length
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= len) {
      return rejectStaleSelection(interaction, playback, page, 'stale_index')
    }
    const removed = playback.removeUpcomingIfRevision(interaction.guildId, selectedIndex, revision)
    if (removed === 'stale') {
      return rejectStaleSelection(interaction, playback, page, 'stale_revision')
    }
    logQueueOp(interaction, removed, JSON.stringify({ action, selectedIndex }))
    const newLen = playback.getState(interaction.guildId).upcoming.length
    const maxPage = Math.max(0, Math.ceil(newLen / 10) - 1)
    return interaction.update(buildQueueEditorPayload(playback.getState(interaction.guildId), { page: Math.min(page, maxPage), selectedIndex: null }))
  }

  if (interaction.isButton() && action === 'qedit_jump') {
    // The submit is a separate interaction — carry the revision through
    // the modal's own custom_id so the move is still guarded on submit.
    const modal = new ModalBuilder()
      .setCustomId(`qedit_jumpmodal_p${page}_i${selectedIndex}${revision != null ? `_r${revision}` : ''}`)
      .setTitle('移動先の位置')
    const input = new TextInputBuilder()
      .setCustomId('qedit_jump_input')
      .setLabel('移動先の位置(1〜)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
    modal.addComponents(new ActionRowBuilder().addComponents(input))
    return interaction.showModal(modal)
  }

  if (interaction.isModalSubmit() && action === 'qedit_jumpmodal') {
    const len = playback.getState(interaction.guildId).upcoming.length
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= len) {
      return rejectStaleSelection(interaction, playback, page, 'stale_index')
    }
    const n = parseInt(interaction.fields.getTextInputValue('qedit_jump_input'), 10)
    if (isNaN(n) || n < 1 || n > len) {
      return interaction.reply({ content: '❌ 無効な位置です', flags: MessageFlags.Ephemeral })
    }
    const toIndex = n - 1
    const moved = playback.moveUpcomingIfRevision(interaction.guildId, selectedIndex, toIndex, revision)
    if (moved === 'stale') {
      return rejectStaleSelection(interaction, playback, page, 'stale_revision')
    }
    logQueueOp(interaction, moved, JSON.stringify({ action, fromIndex: selectedIndex, toIndex }))
    return interaction.update(buildQueueEditorPayload(playback.getState(interaction.guildId), { page, selectedIndex: toIndex }))
  }
}
