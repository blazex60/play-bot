import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { cancelPendingRecommendations } from '../sessions.js'

export default {
  data: new SlashCommandBuilder().setName('leave').setDescription('ボットをVCから退出させます'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ ボットはVCにいません' })
    if (!session) return false
    sessions.delete(interaction.guildId)
    cancelPendingRecommendations(interaction.guildId)
    session.connection.destroy()
    await interaction.reply({ content: `👋 ${interaction.member.displayName} がボットをVCから退出させました`, ...replyFlags(interaction.guildId, 'leave') })
  },
}
