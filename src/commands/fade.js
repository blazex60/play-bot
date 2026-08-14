import { SlashCommandBuilder } from 'discord.js'
import { setFade } from '../settings.js'
import { replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder()
    .setName('fade')
    .setDescription('曲間フェード（クロスフェード）設定を切り替えます')
    .addBooleanOption(opt =>
      opt.setName('enabled').setDescription('フェードを有効にするか').setRequired(true)
    ),

  async execute(interaction) {
    const enabled = interaction.options.getBoolean('enabled', true)
    await setFade(interaction.guildId, enabled)
    await interaction.reply({
      content: `✅ フェードを **${enabled ? '有効' : '無効'}** にしました`,
      ...replyFlags(interaction.guildId, 'fade'),
    })
  },
}
