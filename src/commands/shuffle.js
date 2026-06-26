import { SlashCommandBuilder } from 'discord.js'

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('キューをシャッフルします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      return interaction.reply({ content: '❌ キューが空です', ephemeral: true })
    }
    session.queue.shuffle()
    await interaction.reply('🔀 キューをシャッフルしました')
  },
}
