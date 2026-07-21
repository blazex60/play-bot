import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel, replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('pause').setDescription('再生を一時停止します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    if (!checkSameVoiceChannel(interaction, session)) return
    if (session.player.pause()) {
      await interaction.reply({ content: `⏸️ ${interaction.member.displayName} が一時停止しました`, ...replyFlags(interaction.guildId, 'pause') })
    } else {
      await interaction.reply({ content: '❌ 現在再生中ではありません', flags: MessageFlags.Ephemeral })
    }
  },
}
