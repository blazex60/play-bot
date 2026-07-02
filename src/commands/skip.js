import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('skip').setDescription('現在の曲をスキップします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    if (!checkSameVoiceChannel(interaction, session)) return
    const title = session.queue.current?.title ?? '不明'
    await session.player.skip()
    await interaction.reply(`⏭️ ${interaction.member.displayName} がスキップしました: **${title}**`)
  },
}
