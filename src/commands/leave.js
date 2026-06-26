import { SlashCommandBuilder } from 'discord.js'

export default {
  data: new SlashCommandBuilder().setName('leave').setDescription('ボットをVCから退出させます'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ ボットはVCにいません', ephemeral: true })
    sessions.delete(interaction.guildId)
    session.connection.destroy()
    await interaction.reply('👋 VCから退出しました')
  },
}
