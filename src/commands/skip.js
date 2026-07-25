import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('skip').setDescription('現在の曲をスキップします'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ 再生中の曲がありません' })
    if (!session) return false
    const title = session.queue.current?.title ?? '不明'
    await session.player.skip()
    await interaction.reply({ content: `⏭️ ${interaction.member.displayName} がスキップしました: **${title}**`, ...replyFlags(interaction.guildId, 'skip') })
  },
}
