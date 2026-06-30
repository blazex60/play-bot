import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js'
import { LoopMode } from '../queue.js'

const LOOP_LABELS = {
  [LoopMode.OFF]: 'オフ',
  [LoopMode.TRACK]: '1曲リピート',
  [LoopMode.QUEUE]: 'キューリピート',
}

function fmtDuration(seconds) {
  if (seconds == null) return '不明'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export default {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('現在再生中の曲を表示します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    const track = session.queue.current
    if (!track) return interaction.reply({ content: '📭 現在再生中の曲はありません', flags: MessageFlags.Ephemeral })

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
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
  },
}
