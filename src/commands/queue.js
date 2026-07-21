import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { buildQueueEditorPayload } from '../queueEditorView.js'
import { replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('queue').setDescription('現在のキューを表示します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      await interaction.reply({ content: '📭 キューは空です', flags: MessageFlags.Ephemeral })
      return false
    }
    await interaction.reply({ ...buildQueueEditorPayload(session.queue, { page: 0 }), ...replyFlags(interaction.guildId, 'queue') })
  },
}
