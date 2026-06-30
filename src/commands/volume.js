import { SlashCommandBuilder, MessageFlags } from 'discord.js'

export default {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('音量を設定します（0〜200）')
    .addIntegerOption(opt =>
      opt.setName('level').setDescription('音量 0〜200').setMinValue(0).setMaxValue(200).setRequired(true)
    ),

  async execute(interaction, sessions) {
    const session = sessions.get(interaction.guildId)
    if (!session) return interaction.reply({ content: '❌ 再生中の曲がありません', flags: MessageFlags.Ephemeral })
    const level = interaction.options.getInteger('level')
    session.player.setVolume(level / 100)
    await interaction.reply({ content: `🔊 音量を ${level}% に設定しました`, flags: MessageFlags.Ephemeral })
  },
}
