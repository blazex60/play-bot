import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('キューをシャッフルします'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      return interaction.reply({ content: '❌ キューが空です', flags: MessageFlags.Ephemeral })
    }
    if (!checkSameVoiceChannel(interaction, session)) return
    session.queue.shuffle()
    await interaction.reply({ content: `🔀 ${interaction.member.displayName} がキューをシャッフルしました`, flags: MessageFlags.Ephemeral })
  },
}
