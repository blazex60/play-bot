import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { bumpPlanToken, cancelPendingRecommendations } from '../sessions.js'

export default {
  data: new SlashCommandBuilder().setName('stop').setDescription('再生を停止してキューをクリアします'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ 再生中の曲がありません' })
    if (!session) return false
    await session.player.stop()
    // Invalidate any in-flight autoplay planning for this session: without
    // this, a queue-exhaustion continuation resolving after the stop would
    // see an empty queue and think it's still safe to auto-start a track.
    bumpPlanToken(interaction.guildId)
    cancelPendingRecommendations(interaction.guildId)
    await interaction.reply({ content: `⏹️ ${interaction.member.displayName} が再生を停止してキューをクリアしました`, ...replyFlags(interaction.guildId, 'stop') })
  },
}
