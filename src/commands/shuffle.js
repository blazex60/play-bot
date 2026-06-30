import { SlashCommandBuilder, MessageFlags } from 'discord.js'

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('キューをシャッフルします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      return interaction.reply({ content: '❌ キューが空です', flags: MessageFlags.Ephemeral })
    }
    session.queue.shuffle()
    await interaction.reply({ content: '🔀 キューをシャッフルしました', flags: MessageFlags.Ephemeral })
  },
}
