import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { LoopMode } from '../queue.js'
import { checkSameVoiceChannel, replyFlags } from '../permissions.js'

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
    if (!session) {
      await interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
      return false
    }
    if (!checkSameVoiceChannel(interaction, session)) return false
    const newMode = session.queue.cycleLoop()
    await interaction.reply({ content: `🔁 ${interaction.member.displayName} がループモードを変更しました: **${LOOP_LABELS[newMode]}**`, ...replyFlags(interaction.guildId, 'loop') })
  },
}
