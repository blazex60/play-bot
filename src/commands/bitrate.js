import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { replyFlags } from '../permissions.js'

const BITRATE_BY_TIER = { 0: 96_000, 1: 128_000, 2: 256_000, 3: 384_000 }

export default {
  data: new SlashCommandBuilder()
    .setName('bitrate')
    .setDescription('VCのビットレートを設定します（省略時はサーバー最大値）')
    .addIntegerOption(opt =>
      opt.setName('kbps').setDescription('ビットレート (kbps)。省略するとサーバー最大値').setMinValue(8).setRequired(false)
    ),

  async execute(interaction, sessions) {
    await interaction.deferReply({ ephemeral: true })
    const member = interaction.member
    if (!member.voice?.channel) {
      await interaction.editReply({ content: '❌ まずVCに参加してください' })
      return false
    }
    const channel = member.voice.channel
    const tier = interaction.guild.premiumTier
    const maxBitrate = BITRATE_BY_TIER[tier] ?? 96_000
    const kbps = interaction.options.getInteger('kbps')
    const target = kbps === null ? maxBitrate : Math.min(kbps * 1000, maxBitrate)
    try {
      await channel.setBitrate(target)
    } catch {
      await interaction.editReply({ content: '❌ チャンネルの編集権限がありません' })
      return false
    }
    const suffix = kbps !== null && target < kbps * 1000 ? `（Tier${tier} 上限に丸めました）` : ''
    // The deferred reply above is always ephemeral so error paths stay
    // personal; the success message's visibility is configurable, so it's
    // sent as an independent followUp after dropping the ephemeral one.
    await interaction.deleteReply().catch(() => {})
    await interaction.followUp({ content: `✅ ビットレートを **${target / 1000}kbps** に設定しました${suffix}`, ...replyFlags(interaction.guildId, 'bitrate') })
  },
}
