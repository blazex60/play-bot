import { MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js'
import { buildQueueEditorPayload } from './queueEditorView.js'
import { checkSameVoiceChannel } from './permissions.js'

const CUSTOM_ID_RE = /^(qedit_[a-z]+)_p(\d+)(?:_i(\d+))?$/

function parseCustomId(customId) {
  const match = customId.match(CUSTOM_ID_RE)
  if (!match) return null
  const [, action, pageStr, indexStr] = match
  return {
    action,
    page: parseInt(pageStr, 10),
    selectedIndex: indexStr !== undefined ? parseInt(indexStr, 10) : null,
  }
}

export async function handleQueueEditorInteraction(interaction, sessions) {
  const parsed = parseCustomId(interaction.customId)
  if (!parsed) return
  const { action, page } = parsed
  let { selectedIndex } = parsed

  const session = sessions.get(interaction.guildId)

  if (interaction.isButton() && action === 'qedit_close') {
    if (!checkSameVoiceChannel(interaction, session)) return
    await interaction.deferUpdate()
    return interaction.message.delete().catch(() => {})
  }

  if (!session || session.queue.isEmpty) {
    return interaction.reply({ content: '📭 キューは空です', flags: MessageFlags.Ephemeral })
  }

  if (!checkSameVoiceChannel(interaction, session)) return

  const { queue } = session

  if (interaction.isStringSelectMenu() && action === 'qedit_select') {
    selectedIndex = parseInt(interaction.values[0], 10)
    return interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex }))
  }

  if (interaction.isButton() && action === 'qedit_page') {
    return interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex: null }))
  }

  if (interaction.isButton() && (action === 'qedit_moveup' || action === 'qedit_movedown' || action === 'qedit_tofront')) {
    const len = queue.upcoming().length
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= len) {
      await interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex: null }))
      return interaction.followUp({ content: '⚠️ キューが変更されました。もう一度選択してください', flags: MessageFlags.Ephemeral })
    }
    const toIndex = action === 'qedit_moveup' ? selectedIndex - 1
      : action === 'qedit_movedown' ? selectedIndex + 1
      : 0
    const moved = queue.moveUpcoming(selectedIndex, toIndex)
    return interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex: moved ? toIndex : selectedIndex }))
  }

  if (interaction.isButton() && action === 'qedit_remove') {
    const len = queue.upcoming().length
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= len) {
      await interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex: null }))
      return interaction.followUp({ content: '⚠️ キューが変更されました。もう一度選択してください', flags: MessageFlags.Ephemeral })
    }
    queue.removeUpcoming(selectedIndex)
    const newLen = queue.upcoming().length
    const maxPage = Math.max(0, Math.ceil(newLen / 10) - 1)
    return interaction.update(buildQueueEditorPayload(queue, { page: Math.min(page, maxPage), selectedIndex: null }))
  }

  if (interaction.isButton() && action === 'qedit_jump') {
    const modal = new ModalBuilder()
      .setCustomId(`qedit_jumpmodal_p${page}_i${selectedIndex}`)
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
    const len = queue.upcoming().length
    if (selectedIndex === null || selectedIndex < 0 || selectedIndex >= len) {
      await interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex: null }))
      return interaction.followUp({ content: '⚠️ キューが変更されました。もう一度選択してください', flags: MessageFlags.Ephemeral })
    }
    const n = parseInt(interaction.fields.getTextInputValue('qedit_jump_input'), 10)
    if (isNaN(n) || n < 1 || n > len) {
      return interaction.reply({ content: '❌ 無効な位置です', flags: MessageFlags.Ephemeral })
    }
    const toIndex = n - 1
    queue.moveUpcoming(selectedIndex, toIndex)
    return interaction.update(buildQueueEditorPayload(queue, { page, selectedIndex: toIndex }))
  }
}
