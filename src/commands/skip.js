import { SlashCommandBuilder } from 'discord.js'

export default {
  data: new SlashCommandBuilder().setName('skip').setDescription('現在の曲をスキップします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', ephemeral: true })
    const title = session.queue.current?.title ?? '不明'
    await session.player.skip()
    await interaction.reply(`⏭️ スキップしました: **${title}**`)
  },
}
