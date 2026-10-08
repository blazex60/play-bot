import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js'
import { fmtDuration, LOOP_LABELS } from '../shared/format.js'

const PAGE_SIZE = 10

// Renders the queue editor from a playback-state snapshot ({ current,
// upcoming, loopMode }) — e.g. PlaybackService#getState — rather than the
// GuildQueue itself, so Discord UI code never touches queue internals.
export function buildQueueEditorPayload(queueState, { page = 0, selectedIndex = null } = {}) {
  const current = queueState.current
  const upcoming = queueState.upcoming
  // Optimistic-concurrency token embedded into every custom_id and select
  // value: the mutating buttons are index-based, so any queue change after
  // this render makes them stale and the handler rejects the op instead of
  // hitting the wrong track. The queue's own id travels with it (_q) — the
  // revision restarts at 0 for each new session's queue, so without the id
  // a button rendered under a destroyed session could collide with its
  // replacement's revision. Well under Discord's 100-char custom_id limit.
  const revision = Number.isInteger(queueState.revision) ? queueState.revision : 0
  const queueId = Number.isInteger(queueState.queueId) ? queueState.queueId : null
  const revSuffix = `_r${revision}${queueId != null ? `_q${queueId}` : ''}`
  const valueSuffix = `:r${revision}${queueId != null ? `:q${queueId}` : ''}`
  const totalPages = Math.max(1, Math.ceil(upcoming.length / PAGE_SIZE))
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1)
  const pageStart = clampedPage * PAGE_SIZE
  const pageItems = upcoming.slice(pageStart, pageStart + PAGE_SIZE)
  const effectiveSelectedIndex =
    selectedIndex != null && selectedIndex >= 0 && selectedIndex < upcoming.length ? selectedIndex : null

  const embed = new EmbedBuilder().setTitle('🎵 キュー編集').setColor(0x5865f2)

  const lines = []
  if (current) {
    lines.push(`**▶ 再生中:** ${current.title} (${fmtDuration(current.duration)})`)
    lines.push(`　└ リクエスト: ${current.requestedBy}`)
  } else {
    lines.push('**▶ 再生中:** なし')
  }
  lines.push('')
  if (pageItems.length) {
    lines.push('**次の曲:**')
    pageItems.forEach((t, i) => {
      const absIndex = pageStart + i
      const marker = absIndex === effectiveSelectedIndex ? '▶ ' : '　'
      lines.push(`${marker}${absIndex + 1}. ${t.title} (${fmtDuration(t.duration)}) — ${t.requestedBy}`)
    })
  } else {
    lines.push('次の曲はありません')
  }
  embed.setDescription(lines.join('\n'))
  embed.setFooter({ text: `ページ ${clampedPage + 1}/${totalPages} ・ ループ: ${LOOP_LABELS[queueState.loopMode]}` })

  const components = []

  if (pageItems.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`qedit_select_p${clampedPage}${revSuffix}`)
      .setPlaceholder('曲を選択...')
      .addOptions(
        pageItems.map((t, i) => {
          const absIndex = pageStart + i
          return {
            label: `${absIndex + 1}. ${t.title}`.slice(0, 80),
            description: fmtDuration(t.duration).slice(0, 80),
            value: `${absIndex}${valueSuffix}`,
            default: absIndex === effectiveSelectedIndex,
          }
        })
      )
    components.push(new ActionRowBuilder().addComponents(select))
  }

  const prevButton = new ButtonBuilder()
    .setCustomId(`qedit_page_p${clampedPage - 1}${revSuffix}`)
    .setLabel('◀ 前へ')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(clampedPage <= 0)
  const nextButton = new ButtonBuilder()
    .setCustomId(`qedit_page_p${clampedPage + 1}${revSuffix}`)
    .setLabel('次へ ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(clampedPage >= totalPages - 1)
  const closeButton = new ButtonBuilder()
    .setCustomId(`qedit_close_p${clampedPage}${revSuffix}`)
    .setLabel('✖ 閉じる')
    .setStyle(ButtonStyle.Secondary)
  components.push(new ActionRowBuilder().addComponents(prevButton, nextButton, closeButton))

  if (effectiveSelectedIndex != null) {
    const suffix = `_p${clampedPage}_i${effectiveSelectedIndex}${revSuffix}`
    const upButton = new ButtonBuilder()
      .setCustomId(`qedit_moveup${suffix}`)
      .setLabel('↑')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(effectiveSelectedIndex === 0)
    const downButton = new ButtonBuilder()
      .setCustomId(`qedit_movedown${suffix}`)
      .setLabel('↓')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(effectiveSelectedIndex === upcoming.length - 1)
    const toFrontButton = new ButtonBuilder()
      .setCustomId(`qedit_tofront${suffix}`)
      .setLabel('⏭ 次に再生')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(effectiveSelectedIndex === 0)
    const jumpButton = new ButtonBuilder()
      .setCustomId(`qedit_jump${suffix}`)
      .setLabel('🎯 移動')
      .setStyle(ButtonStyle.Secondary)
    const removeButton = new ButtonBuilder()
      .setCustomId(`qedit_remove${suffix}`)
      .setLabel('🗑 削除')
      .setStyle(ButtonStyle.Danger)
    components.push(
      new ActionRowBuilder().addComponents(upButton, downButton, toFrontButton, jumpButton, removeButton)
    )
  }

  return { embeds: [embed], components }
}
