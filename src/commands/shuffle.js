import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('キューをシャッフルします'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, {
      emptyMessage: '❌ キューが空です',
      isEmpty: (s) => s.queue.isEmpty,
    })
    if (!session) return false
    session.queue.shuffle()
    await interaction.reply({ content: `🔀 ${interaction.member.displayName} がキューをシャッフルしました`, ...replyFlags(interaction.guildId, 'shuffle') })
  },
}
