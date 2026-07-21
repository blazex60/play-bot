import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { createTrack } from '../queue.js'
import { searchYoutube, resolveMetadata, isPlaylistUrl, resolveFlatPlaylist, PLAYLIST_LIMIT } from '../search.js'
import { createSearchResultComponents } from '../views.js'
import { getOrCreateSession, pendingStore, webClient } from '../sessions.js'
import { checkSameVoiceChannel, checkCommandAllowed, replyFlags } from '../permissions.js'

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

    // VC所属チェックは同期的で即終了するため、後続の非同期処理に必要な
    // deferReplyより前に行う(他のVC操作コマンドと同じ「先頭でガード」の順序)。
    // まだdeferしていないので checkSameVoiceChannel は interaction.reply を使う。
    const member = interaction.member
    if (!member.voice?.channel) {
      await interaction.reply({ content: '❌ まずVCに参加してください', flags: MessageFlags.Ephemeral })
      return false
    }
    const channel = member.voice.channel
    if (!checkSameVoiceChannel(interaction, sessions.get(interaction.guildId))) return false

    // URL直接再生は play の表示設定に従ってdefer(ephemeralは defer 時点で
    // 固定され、後から followUp で覆せないため)。キーワード検索は常に
    // ephemeral（検索パネルを本人のみ表示・操作させるためで、表示設定とは無関係）
    const playVisibility = replyFlags(interaction.guildId, 'play')
    await interaction.deferReply(isUrl ? playVisibility : { ephemeral: true })

    if (isUrl) {
      if (isPlaylistUrl(query)) {
        let tracks, truncated
        try {
          ({ tracks, truncated } = await resolveFlatPlaylist(query, {
            requestedBy: interaction.member.displayName,
            requestedById: interaction.member.id,
          }))
        } catch (err) {
          await interaction.deleteReply().catch(() => {})
          await interaction.followUp({ content: `❌ プレイリストの取得に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
          return false
        }

        if (!tracks.length) {
          await interaction.deleteReply().catch(() => {})
          await interaction.followUp({ content: '❌ プレイリストに動画が見つかりませんでした', flags: MessageFlags.Ephemeral })
          return false
        }

        let session
        try {
          session = await getOrCreateSession({ guildId: interaction.guildId, guild: interaction.guild, channel, textChannelId: interaction.channelId })
        } catch (err) {
          await interaction.deleteReply().catch(() => {})
          await interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
          return false
        }

        const wasEmpty = session.queue.isEmpty
        for (const track of tracks) session.queue.add(track)

        const truncNote = truncated ? `\n⚠️ プレイリストが大きいため先頭 ${PLAYLIST_LIMIT} 件のみ追加しました` : ''
        // Drop the deferred "thinking" placeholder before the real result —
        // otherwise it's left dangling forever since nothing ever edits it.
        await interaction.deleteReply().catch(() => {})
        await interaction.followUp({ content: `✅ ${interaction.member.displayName} がプレイリストから **${tracks.length}曲** をキューに追加しました${truncNote}`, ...playVisibility })
        if (wasEmpty) await session.player.playNext()
        return
      }

      let info
      try {
        info = await resolveMetadata(query, { requestedBy: interaction.member.displayName, requestedById: interaction.member.id })
      } catch (err) {
        await interaction.deleteReply().catch(() => {})
        await interaction.followUp({ content: `❌ 取得に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
        return false
      }

      let session
      try {
        session = await getOrCreateSession({ guildId: interaction.guildId, guild: interaction.guild, channel, textChannelId: interaction.channelId })
      } catch (err) {
        await interaction.deleteReply().catch(() => {})
        await interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
        return false
      }

      const wasEmpty = session.queue.isEmpty
      session.queue.add(createTrack(info))
      await interaction.deleteReply().catch(() => {})
      await interaction.followUp({ content: `✅ ${interaction.member.displayName} がキューに追加しました: **${info.title}** (${fmtDuration(info.duration)})`, ...playVisibility })
      if (wasEmpty) await session.player.playNext()
      return
    }

    // Keyword search
    let results
    try {
      results = await searchYoutube(query)
    } catch (err) {
      await interaction.editReply({ content: `❌ 検索に失敗しました: ${err.message}` })
      return false
    }
    if (!results.length) {
      await interaction.editReply({ content: '❌ 検索結果が見つかりませんでした' })
      return false
    }

    const components = createSearchResultComponents(results)
    const msg = await interaction.editReply({ content: '🔍 検索結果:', components })

    // buttonInteraction is the later button click that picks a search
    // result — a distinct interaction from the /play command interaction
    // captured above, and its member/roles reflect state at click time
    // rather than a potentially stale snapshot from when /play was invoked.
    const onSelect = async (entry, buttonInteraction) => {
      // The initial /play execute() returns null for the keyword-search
      // path (see below) precisely so index.js skips logging a "success" —
      // the real outcome of this command only exists once a result is
      // picked, so this callback is the one place that can log it.
      const logSelect = (success, detail) => webClient.logOperation({
        guildId: interaction.guildId,
        discordUserId: interaction.user.id,
        username: interaction.user.username,
        source: 'command',
        action: 'play',
        success,
        detail,
      })

      // The keyword-search panel is ephemeral and can sit around for a while
      // before the user clicks a result, so re-check 'play' permission here
      // too — the initial checkCommandAllowed in index.js only guarded the
      // slash command dispatch, not this later button click.
      if (!checkCommandAllowed(buttonInteraction, process.env.ADMIN_ROLE_ID, 'play')) {
        logSelect(false, 'blocked')
        return
      }
      if (!checkSameVoiceChannel(buttonInteraction, sessions.get(interaction.guildId))) {
        logSelect(false, 'not_in_voice')
        return
      }
      const url = entry.url || entry.webpage_url
      if (!url) {
        await interaction.followUp({ content: '❌ URLを取得できませんでした', flags: MessageFlags.Ephemeral })
        logSelect(false, 'no_url')
        return
      }
      let info
      try {
        info = await resolveMetadata(url, { requestedBy: interaction.member.displayName, requestedById: interaction.member.id })
      } catch (err) {
        await interaction.followUp({ content: `❌ 取得に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
        logSelect(false, err.message)
        return
      }
      let session
      try {
        session = await getOrCreateSession({ guildId: interaction.guildId, guild: interaction.guild, channel, textChannelId: interaction.channelId })
      } catch (err) {
        await interaction.followUp({ content: `❌ VCへの接続に失敗しました: ${err.message}`, flags: MessageFlags.Ephemeral })
        logSelect(false, err.message)
        return
      }
      await interaction.deleteReply().catch(() => {})
      const wasEmpty = session.queue.isEmpty
      session.queue.add(createTrack(info))
      await interaction.followUp({ content: `✅ ${interaction.member.displayName} がキューに追加しました: **${info.title}** (${fmtDuration(info.duration)})`, ...replyFlags(interaction.guildId, 'play') })
      if (wasEmpty) await session.player.playNext()
      logSelect(true)
    }

    pendingStore.set(msg.id, { results, onSelect })
    // The real outcome isn't known yet (nothing has been enqueued) — signal
    // index.js to skip logging entirely rather than record a false "success"
    // for a search panel the user might never act on.
    return null
  },
}
