import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { LoopMode } from '../queue.js'

const LOOP_LABELS = {
  [LoopMode.OFF]: 'オフ',
  [LoopMode.TRACK]: '1曲リピート',
  [LoopMode.QUEUE]: 'キューリピート',
}

export default {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('ループモードを切り替えます（オフ→1曲→キュー→オフ）'),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    const newMode = session.queue.cycleLoop()
    await interaction.reply({ content: `🔁 ループモード: **${LOOP_LABELS[newMode]}**`, flags: MessageFlags.Ephemeral })
  },
}
