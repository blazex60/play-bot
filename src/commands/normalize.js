import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { setNormalize } from '../settings.js'

export default {
  data: new SlashCommandBuilder()
    .setName('normalize')
    .setDescription('曲ごとの音量ノーマライズ設定を切り替えます')
    .addBooleanOption(opt =>
      opt.setName('enabled').setDescription('ノーマライズを有効にするか').setRequired(true)
    ),

  async execute(interaction) {
    const enabled = interaction.options.getBoolean('enabled', true)
    await setNormalize(interaction.guildId, enabled)
    await interaction.reply({
      content: `✅ ノーマライズを **${enabled ? '有効' : '無効'}** にしました`,
      flags: MessageFlags.Ephemeral,
    })
  },
}
