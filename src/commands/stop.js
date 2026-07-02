import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('stop').setDescription('再生を停止してキューをクリアします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    if (!checkSameVoiceChannel(interaction, session)) return
    await session.player.stop()
    await interaction.reply(`⏹️ ${interaction.member.displayName} が再生を停止してキューをクリアしました`)
  },
}
