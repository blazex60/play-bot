import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { playbackFor } from '../../playback/sessions.js'

export default {
  data: new SlashCommandBuilder().setName('resume').setDescription('再生を再開します'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ 再生中の曲がありません' })
    if (!session) return false
    if (playbackFor(sessions).resume(interaction.guildId)) {
      await interaction.reply({ content: `▶️ ${interaction.member.displayName} が再生を再開しました`, ...replyFlags(interaction.guildId, 'resume') })
    } else {
      await interaction.reply({ content: '❌ 一時停止中ではありません', flags: MessageFlags.Ephemeral })
      return false
    }
  },
}
