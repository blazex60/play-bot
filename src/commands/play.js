import { SlashCommandBuilder } from 'discord.js'
import { createTrack } from '../queue.js'
import { searchYoutube, resolveMetadata, YtdlpError } from '../search.js'
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
    await interaction.deferReply()

    const member = interaction.member
    if (!member.voice?.channel) {
      return interaction.followUp({ content: '❌ まずVCに参加してください', ephemeral: true })
    }
    const channel = member.voice.channel
    const query = interaction.options.getString('query')
    const isUrl = query.startsWith('http://') || query.startsWith('https://')

    if (isUrl) {
      let info
      try {
        info = await resolveMetadata(query, { requestedBy: interaction.member.displayName })
      } catch (err) {
        return interaction.followUp({ content: `❌ 取得に失敗しました: ${err.message}`, ephemeral: true })
      }

      let session
      try {
        session = await getOrCreateSession(interaction, channel)
      } catch (err) {
        return interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, ephemeral: true })
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
      return interaction.followUp({ content: `❌ 検索に失敗しました: ${err.message}`, ephemeral: true })
    }
    if (!results.length) {
      return interaction.followUp({ content: '❌ 検索結果が見つかりませんでした', ephemeral: true })
    }

    const components = createSearchResultComponents(results)
    const msg = await interaction.followUp({ content: '🔍 検索結果:', components })

    const onSelect = async entry => {
      const url = entry.url || entry.webpage_url
      if (!url) {
        await interaction.followUp({ content: '❌ URLを取得できませんでした', ephemeral: true })
        return
      }
      let info
      try {
        info = await resolveMetadata(url, { requestedBy: interaction.member.displayName })
      } catch (err) {
        await interaction.followUp({ content: `❌ 取得に失敗しました: ${err.message}`, ephemeral: true })
        return
      }
      let session
      try {
        session = await getOrCreateSession(interaction, channel)
      } catch (err) {
        await interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, ephemeral: true })
        return
      }
      const wasEmpty = session.queue.isEmpty
      session.queue.add(createTrack(info))
      await interaction.followUp(`✅ キューに追加しました: **${info.title}** (${fmtDuration(info.duration)})`)
      if (wasEmpty) await session.player.playNext()
    }

    pendingStore.set(msg.id, results, onSelect)
  },
}
