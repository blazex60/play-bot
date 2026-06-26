import { SlashCommandBuilder } from 'discord.js'
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
  data: new SlashCommandBuilder().setName('queue').setDescription('現在のキューを表示します'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session || session.queue.isEmpty) {
      return interaction.reply({ content: '📭 キューは空です', ephemeral: true })
    }
    const current = session.queue.current
    const upcoming = session.queue.upcoming()
    const lines = []
    if (current) lines.push(`**▶ 再生中:** ${current.title} (${fmtDuration(current.duration)})`)
    if (upcoming.length) {
      lines.push('**次の曲:**')
      upcoming.slice(0, 10).forEach((t, i) => lines.push(`  ${i + 1}. ${t.title} (${fmtDuration(t.duration)})`))
      if (upcoming.length > 10) lines.push(`  … 他${upcoming.length - 10}曲`)
    }
    lines.push(`\nループ: ${LOOP_LABELS[session.queue.loopMode]}`)
    await interaction.reply(lines.join('\n'))
  },
}
