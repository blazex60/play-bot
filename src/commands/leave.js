import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { checkSameVoiceChannel } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('leave').setDescription('ボットをVCから退出させます'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ ボットはVCにいません', flags: MessageFlags.Ephemeral })
    if (!checkSameVoiceChannel(interaction, session)) return
    sessions.delete(interaction.guildId)
    session.connection.destroy()
    await interaction.reply({ content: `👋 ${interaction.member.displayName} がボットをVCから退出させました`, flags: MessageFlags.Ephemeral })
  },
}
