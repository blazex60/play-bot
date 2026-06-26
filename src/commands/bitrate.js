import { SlashCommandBuilder } from 'discord.js'

const BITRATE_BY_TIER = { 0: 96_000, 1: 128_000, 2: 256_000, 3: 384_000 }

export default {
  data: new SlashCommandBuilder()
    .setName('bitrate')
    .setDescription('VCのビットレートを設定します（省略時はサーバー最大値）')
    .addIntegerOption(opt =>
      opt.setName('kbps').setDescription('ビットレート (kbps)。省略するとサーバー最大値').setMinValue(8).setRequired(false)
    ),

  async execute(interaction, sessions) {
    await interaction.deferReply()
    const member = interaction.member
    if (!member.voice?.channel) {
      return interaction.followUp({ content: '❌ まずVCに参加してください', ephemeral: true })
    }
    const channel = member.voice.channel
    const tier = interaction.guild.premiumTier
    const maxBitrate = BITRATE_BY_TIER[tier] ?? 96_000
    const kbps = interaction.options.getInteger('kbps')
    const target = kbps === null ? maxBitrate : Math.min(kbps * 1000, maxBitrate)
    try {
      await channel.setBitrate(target)
    } catch {
      return interaction.followUp({ content: '❌ チャンネルの編集権限がありません', ephemeral: true })
    }
    const suffix = kbps !== null && target < kbps * 1000 ? `（Tier${tier} 上限に丸めました）` : ''
    await interaction.followUp(`✅ ビットレートを **${target / 1000}kbps** に設定しました${suffix}`)
  },
}
