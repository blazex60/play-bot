import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js'
import { requireSessionInSameVoice, replyFlags } from '../permissions.js'
import { fmtDuration, LOOP_LABELS } from '../format.js'

export default {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('現在再生中の曲を表示します'),

  async execute(interaction, sessions) {
    const session = await requireSessionInSameVoice(interaction, sessions, {
      emptyMessage: '❌ 再生中の曲がありません',
      skipVoiceCheck: true,
    })
    if (!session) return false
    const track = session.queue.current
    if (!track) {
      await interaction.reply({ content: '📭 現在再生中の曲はありません', flags: MessageFlags.Ephemeral })
      return false
    }

    const embed = new EmbedBuilder()
      .setTitle('🎵 Now Playing')
      .setColor(0x5865f2)
      .addFields(
        { name: 'タイトル', value: track.title, inline: false },
        { name: '長さ', value: fmtDuration(track.duration), inline: true },
        { name: 'リクエスト', value: track.requestedBy, inline: true },
        { name: 'ループ', value: LOOP_LABELS[session.queue.loopMode], inline: true },
      )
    if (track.thumbnail) embed.setThumbnail(track.thumbnail)
    await interaction.reply({ embeds: [embed], ...replyFlags(interaction.guildId, 'nowplaying') })
  },
}
