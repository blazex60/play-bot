import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { playbackFor } from '../../playback/sessions.js'

export default {
  data: new SlashCommandBuilder().setName('stop').setDescription('再生を停止してキューをクリアします'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ 再生中の曲がありません' })
    if (!session) return false
    // playback.stop also invalidates any in-flight autoplay planning and
    // drops pending recommendation prompts (its onStop hook), so a stale
    // continuation can't undo the stop.
    await playbackFor(sessions).stop(interaction.guildId)
    await interaction.reply({ content: `⏹️ ${interaction.member.displayName} が再生を停止してキューをクリアしました`, ...replyFlags(interaction.guildId, 'stop') })
  },
}
