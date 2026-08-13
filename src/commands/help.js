import { SlashCommandBuilder, EmbedBuilder } from 'discord.js'
import { replyFlags } from '../permissions.js'

const PLAYBACK_COMMANDS = [
  ['play', '曲を再生します（URL or キーワード検索）'],
  ['pause', '再生を一時停止します'],
  ['resume', '再生を再開します'],
  ['skip', '現在の曲をスキップします'],
  ['stop', '再生を停止してキューをクリアします'],
  ['leave', 'ボットをVCから退出させます'],
  ['queue', '現在のキューを表示します'],
  ['shuffle', 'キューをシャッフルします'],
  ['mix order', 'upcoming を BPM/キーに基づいて MIX 向けに並べ替えます'],
  ['mix create', 'リクエスト文からプレイリストを自動生成して My Playlists に保存します'],
  ['loop', 'ループモードを切り替えます（オフ→1曲→キュー→オフ）'],
  ['nowplaying', '現在再生中の曲を表示します'],
]

const SETTINGS_COMMANDS = [
  ['bitrate', 'VCのビットレートを設定します（省略時はサーバー最大値）'],
  ['normalize', '音量ノーマライズ設定（尺が分かる30分以内の曲はミキサー経路で常に loudnorm）'],
  ['autoplay', 'キューが空になった時の自動再生を設定します'],
  ['adminrole', 'Web管理画面の権限ロールをこのサーバー専用に設定します（要 Administrator）'],
]

function formatCommandList(commands) {
  return commands.map(([name, description]) => `\`/${name}\` - ${description}`).join('\n')
}

export default {
  data: new SlashCommandBuilder().setName('help').setDescription('コマンド一覧とヘルプページのリンクを表示します'),

  async execute(interaction, sessions) {
    const embed = new EmbedBuilder()
      .setTitle('📖 Play-bot コマンド一覧')
      .setColor(0x5865f2)
      .addFields(
        { name: '再生操作', value: formatCommandList(PLAYBACK_COMMANDS), inline: false },
        { name: '設定', value: formatCommandList(SETTINGS_COMMANDS), inline: false },
      )

    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '')
    if (publicBaseUrl) {
      embed.addFields({ name: '詳細なヘルプ', value: `より詳しい使い方は Web ダッシュボードをご覧ください: ${publicBaseUrl}/help`, inline: false })
    }

    await interaction.reply({ embeds: [embed], ...replyFlags(interaction.guildId, 'help') })
  },
}
