import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { buildQueueEditorPayload } from '../queueEditorView.js'
import { replyFlags } from '../permissions.js'
import { playbackFor } from '../../playback/sessions.js'

export default {
  data: new SlashCommandBuilder().setName('queue').setDescription('現在のキューを表示します'),

  async execute(interaction, sessions) {
    const state = playbackFor(sessions).getState(interaction.guildId)
    if (!state.active || state.isEmpty) {
      await interaction.reply({ content: '📭 キューは空です', flags: MessageFlags.Ephemeral })
      return false
    }
    await interaction.reply({ ...buildQueueEditorPayload(state, { page: 0 }), ...replyFlags(interaction.guildId, 'queue') })
  },
}
