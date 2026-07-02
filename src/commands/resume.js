import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('resume').setDescription('再生を再開します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    if (!checkSameVoiceChannel(interaction, session)) return
    if (session.player.resume()) {
      await interaction.reply(`▶️ ${interaction.member.displayName} が再生を再開しました`)
    } else {
      await interaction.reply({ content: '❌ 一時停止中ではありません', flags: MessageFlags.Ephemeral })
    }
  },
}
