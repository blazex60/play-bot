import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel, replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('キューをシャッフルします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      await interaction.reply({ content: '❌ キューが空です', flags: MessageFlags.Ephemeral })
      return false
    }
    if (!checkSameVoiceChannel(interaction, session)) return false
    session.queue.shuffle()
    await interaction.reply({ content: `🔀 ${interaction.member.displayName} がキューをシャッフルしました`, ...replyFlags(interaction.guildId, 'shuffle') })
  },
}
