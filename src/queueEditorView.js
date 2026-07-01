import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js'
import { LoopMode } from './queue.js'

const PAGE_SIZE = 10

const LOOP_LABELS = {
  [LoopMode.OFF]: 'オフ',
  [LoopMode.TRACK]: '1曲リピート',
  [LoopMode.QUEUE]: 'キューリピート',
}

function fmtDuration(seconds) {
  if (seconds == null) return '不明'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function buildQueueEditorPayload(queue, { page = 0, selectedIndex = null } = {}) {
  const current = queue.current
  const upcoming = queue.upcoming()
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
  } else {
    lines.push('**▶ 再生中:** なし')
  }
  lines.push('')
  if (pageItems.length) {
    lines.push('**次の曲:**')
    pageItems.forEach((t, i) => {
      const absIndex = pageStart + i
      const marker = absIndex === effectiveSelectedIndex ? '▶ ' : '　'
      lines.push(`${marker}${absIndex + 1}. ${t.title} (${fmtDuration(t.duration)})`)
    })
  } else {
    lines.push('次の曲はありません')
  }
  embed.setDescription(lines.join('\n'))
  embed.setFooter({ text: `ページ ${clampedPage + 1}/${totalPages} ・ ループ: ${LOOP_LABELS[queue.loopMode]}` })

  const components = []

  if (pageItems.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`qedit_select_p${clampedPage}`)
      .setPlaceholder('曲を選択...')
      .addOptions(
        pageItems.map((t, i) => {
          const absIndex = pageStart + i
          return {
            label: `${absIndex + 1}. ${t.title}`.slice(0, 80),
            description: fmtDuration(t.duration).slice(0, 80),
            value: String(absIndex),
            default: absIndex === effectiveSelectedIndex,
          }
        })
      )
    components.push(new ActionRowBuilder().addComponents(select))
  }

  const prevButton = new ButtonBuilder()
    .setCustomId(`qedit_page_p${clampedPage - 1}`)
    .setLabel('◀ 前へ')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(clampedPage <= 0)
  const nextButton = new ButtonBuilder()
    .setCustomId(`qedit_page_p${clampedPage + 1}`)
    .setLabel('次へ ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(clampedPage >= totalPages - 1)
  const closeButton = new ButtonBuilder()
    .setCustomId(`qedit_close_p${clampedPage}`)
    .setLabel('✖ 閉じる')
    .setStyle(ButtonStyle.Secondary)
  components.push(new ActionRowBuilder().addComponents(prevButton, nextButton, closeButton))

  if (effectiveSelectedIndex != null) {
    const suffix = `_p${clampedPage}_i${effectiveSelectedIndex}`
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
