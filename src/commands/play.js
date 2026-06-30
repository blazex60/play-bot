import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { createTrack } from '../queue.js'
import { searchYoutube, resolveMetadata } from '../search.js'
import { createSearchResultComponents } from '../views.js'
import { getOrCreateSession, pendingStore } from '../sessions.js'

function fmtDuration(seconds) {
  if (seconds == null) return '不明'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('曲を再生します（URL or キーワード検索）')
    .addStringOption(opt =>
      opt.setName('query').setDescription('YouTube URL またはキーワード').setRequired(true)
    ),

  async execute(interaction, sessions) {
    const query = interaction.options.getString('query')
    const isUrl = query.startsWith('http://') || query.startsWith('https://')

    // URL直接再生は公開defer。キーワード検索はephemeral（検索パネルを本人のみ表示）
    await interaction.deferReply(isUrl ? {} : { ephemeral: true })

    const member = interaction.member
    if (!member.voice?.channel) {
      if (isUrl) {
        return interaction.followUp({ content: '❌ まずVCに参加してください', flags: MessageFlags.Ephemeral })
      }
      return interaction.editReply({ content: '❌ まずVCに参加してください' })
    }
    const channel = member.voice.channel

    if (isUrl) {
      let info
      try {
        info = await resolveMetadata(query, { requestedBy: interaction.member.displayName })
      } catch (err) {
        return interaction.followUp({ content: `❌ 取得に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
      }

      let session
      try {
        session = await getOrCreateSession(interaction, channel)
      } catch (err) {
        return interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
      }

      const wasEmpty = session.queue.isEmpty
      session.queue.add(createTrack(info))
      await interaction.followUp(`✅ キューに追加しました: **${info.title}** (${fmtDuration(info.duration)})`)
      if (wasEmpty) await session.player.playNext()
      return
    }

    // Keyword search
    let results
    try {
      results = await searchYoutube(query)
    } catch (err) {
      return interaction.editReply({ content: `❌ 検索に失敗しました: ${err.message}` })
    }
    if (!results.length) {
      return interaction.editReply({ content: '❌ 検索結果が見つかりませんでした' })
    }

    const components = createSearchResultComponents(results)
    const msg = await interaction.editReply({ content: '🔍 検索結果:', components })

    const onSelect = async entry => {
      const url = entry.url || entry.webpage_url
      if (!url) {
        await interaction.followUp({ content: '❌ URLを取得できませんでした', flags: MessageFlags.Ephemeral })
        return
      }
      let info
      try {
        info = await resolveMetadata(url, { requestedBy: interaction.member.displayName })
      } catch (err) {
        await interaction.followUp({ content: `❌ 取得に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
        return
      }
      let session
      try {
        session = await getOrCreateSession(interaction, channel)
      } catch (err) {
        await interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.deleteReply().catch(() => {})
      const wasEmpty = session.queue.isEmpty
      session.queue.add(createTrack(info))
      await interaction.followUp(`✅ キューに追加しました: **${info.title}** (${fmtDuration(info.duration)})`)
      if (wasEmpty) await session.player.playNext()
    }

    pendingStore.set(msg.id, results, onSelect)
  },
}
