import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { buildQueueEditorPayload } from '../queueEditorView.js'

export default {
  data: new SlashCommandBuilder().setName('queue').setDescription('現在のキューを表示します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      return interaction.reply({ content: '📭 キューは空です', flags: MessageFlags.Ephemeral })
    }
    await interaction.reply(buildQueueEditorPayload(session.queue, { page: 0 }))
  },
}
