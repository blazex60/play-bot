import { SlashCommandBuilder } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { playbackFor } from '../../playback/sessions.js'
import { LOOP_LABELS } from '../../shared/format.js'

export default {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('ループモードを切り替えます（オフ→1曲→キュー→オフ）'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, { emptyMessage: '❌ 再生中の曲がありません' })
    if (!session) return false
    const newMode = playbackFor(sessions).cycleLoop(interaction.guildId)
    await interaction.reply({ content: `🔁 ${interaction.member.displayName} がループモードを変更しました: **${LOOP_LABELS[newMode]}**`, ...replyFlags(interaction.guildId, 'loop') })
  },
}
