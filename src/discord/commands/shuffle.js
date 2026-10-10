import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { playbackFor } from '../../playback/sessions.js'

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('キューをシャッフルします'),

  async execute(interaction, sessions) {
    const playback = playbackFor(sessions)
    const session = await requireSessionInSameVoice(interaction, sessions, {
      emptyMessage: '❌ キューが空です',
      isEmpty: () => playback.queueIsEmpty(interaction.guildId),
    })
    if (!session) return false
    playback.shuffle(interaction.guildId)
    await interaction.reply({ content: `🔀 ${interaction.member.displayName} がキューをシャッフルしました`, ...replyFlags(interaction.guildId, 'shuffle') })
  },
}
