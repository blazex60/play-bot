import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { setNormalize } from '../settings.js'
import { replyFlags } from '../permissions.js'

export default {
  data: new SlashCommandBuilder()
    .setName('normalize')
    .setDescription('音量ノーマライズ設定（30分以内は loudnorm、尺不明・30分超はストリーム再生）')
    .addBooleanOption(opt =>
      opt.setName('enabled').setDescription('ノーマライズを有効にするか').setRequired(true)
    ),

  async execute(interaction) {
    const enabled = interaction.options.getBoolean('enabled', true)
    await setNormalize(interaction.guildId, enabled)
    const content = enabled
      ? '✅ ノーマライズを **有効** にしました。尺が分かる30分以内の曲は PCM ミキサー経路で loudnorm を適用します'
      : '⚠️ 設定は保存しましたが、PCM ミキサー経路ではクロスフェード品質のため、尺が分かる30分以内の曲のノーマライズは無効になりません'
    await interaction.reply({
      content,
      ...replyFlags(interaction.guildId, 'normalize'),
    })
  },
}
