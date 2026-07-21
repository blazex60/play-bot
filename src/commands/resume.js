import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel, replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('resume').setDescription('再生を再開します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) {
      await interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
      return false
    }
    if (!checkSameVoiceChannel(interaction, session)) return false
    if (session.player.resume()) {
      await interaction.reply({ content: `▶️ ${interaction.member.displayName} が再生を再開しました`, ...replyFlags(interaction.guildId, 'resume') })
    } else {
      await interaction.reply({ content: '❌ 一時停止中ではありません', flags: MessageFlags.Ephemeral })
      return false
    }
  },
}
