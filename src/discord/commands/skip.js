import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { playbackFor } from '../../playback/sessions.js'

export default {
  data: new SlashCommandBuilder().setName('skip').setDescription('現在の曲をスキップします'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ 再生中の曲がありません' })
    if (!session) return false
    const playback = playbackFor(sessions)
    const title = playback.getState(interaction.guildId).current?.title ?? '不明'
    await playback.skip(interaction.guildId)
    await interaction.reply({ content: `⏭️ ${interaction.member.displayName} がスキップしました: **${title}**`, ...replyFlags(interaction.guildId, 'skip') })
  },
}
