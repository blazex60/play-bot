import { SlashCommandBuilder } from 'discord.js'

export default {
  data: new SlashCommandBuilder().setName('stop').setDescription('再生を停止してキューをクリアします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', ephemeral: true })
    await session.player.stop()
    await interaction.reply('⏹️ 再生を停止してキューをクリアしました')
  },
}
