import { SlashCommandBuilder } from 'discord.js'

export default {
  data: new SlashCommandBuilder().setName('resume').setDescription('再生を再開します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', ephemeral: true })
    if (session.player.resume()) {
      await interaction.reply('▶️ 再生を再開しました')
    } else {
      await interaction.reply({ content: '❌ 一時停止中ではありません', ephemeral: true })
    }
  },
}
