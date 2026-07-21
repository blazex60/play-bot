import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel, replyFlags } from '../permissions.js'
import { cancelPendingRecommendations } from '../sessions.js'

export default {
  data: new SlashCommandBuilder().setName('leave').setDescription('ボットをVCから退出させます'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) {
      await interaction.reply({ content: '❌ ボットはVCにいません', flags: MessageFlags.Ephemeral })
      return false
    }
    if (!checkSameVoiceChannel(interaction, session)) return false
    sessions.delete(interaction.guildId)
    cancelPendingRecommendations(interaction.guildId)
    session.connection.destroy()
    await interaction.reply({ content: `👋 ${interaction.member.displayName} がボットをVCから退出させました`, ...replyFlags(interaction.guildId, 'leave') })
  },
}
