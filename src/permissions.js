import { MessageFlags } from 'discord.js'
import { resolveCommandPermission, getCommandVisibilitySettings } from './settings.js'

// Historical hardcoded reply visibility, kept as the fallback for any guild
// that hasn't customized a given command via the admin dashboard yet.
const DEFAULT_VISIBILITY = {
  play: 'public',
  skip: 'public',
  pause: 'public',
  resume: 'public',
  stop: 'public',
  leave: 'public',
  queue: 'public',
  shuffle: 'personal',
  loop: 'personal',
  nowplaying: 'personal',
  bitrate: 'personal',
  normalize: 'personal',
  autoplay: 'personal',
}

// Whether interaction.member (has adminRoleId) should bypass a command's
// allow/deny setting entirely, so an admin can never lock themselves out.
function hasAdminRole(interaction, adminRoleId) {
  return Boolean(adminRoleId && interaction.member?.roles?.cache?.has?.(adminRoleId))
}

// commandName defaults to the slash command being invoked, but callers that
// gate a *component* interaction belonging to a command (e.g. the /queue
// editor's buttons) must pass it explicitly — button/select/modal
// interactions have no interaction.commandName of their own, so without an
// explicit override a denied user's queue-editor clicks would silently skip
// the permission check entirely. guildId likewise defaults to
// interaction.guildId but must be passed explicitly for DM-originated
// interactions (e.g. autoplay recommendation picks), which have no guild
// context of their own.
export function checkCommandAllowed(interaction, adminRoleId, commandName = interaction.commandName, guildId = interaction.guildId) {
  if (hasAdminRole(interaction, adminRoleId)) return true
  const permission = resolveCommandPermission(guildId, interaction.user.id, commandName)
  if (permission === 'deny') {
    const payload = { content: '❌ このコマンドの実行は制限されています', flags: MessageFlags.Ephemeral }
    if (interaction.deferred || interaction.replied) {
      interaction.followUp(payload).catch(() => {})
    } else {
      interaction.reply(payload).catch(() => {})
    }
    return false
  }
  return true
}

export function getEffectiveCommandVisibility(guildId, commandName) {
  const overrides = getCommandVisibilitySettings(guildId)
  return overrides[commandName] ?? DEFAULT_VISIBILITY[commandName] ?? 'public'
}

export function replyFlags(guildId, commandName) {
  return getEffectiveCommandVisibility(guildId, commandName) === 'personal'
    ? { flags: MessageFlags.Ephemeral }
    : {}
}

export function checkSameVoiceChannel(interaction, session) {
  const targetChannelId = session
    ? session.connection.joinConfig.channelId
    : interaction.member.voice?.channelId
  if (!targetChannelId) return true
  const inVoice = interaction.member.voice.channelId === targetChannelId
  const inChat = interaction.channelId === targetChannelId
  if (!inVoice || !inChat) {
    const payload = { content: '❌ 参加しているボイスチャンネルのチャットから操作してください', flags: MessageFlags.Ephemeral }
    if (interaction.deferred || interaction.replied) {
      interaction.followUp(payload)
    } else {
      interaction.reply(payload)
    }
    return false
  }
  return true
}

// Like checkSameVoiceChannel, but without the "same text channel as the VC"
// requirement. Recommendation prompts are now sent as DMs, so there's no
// shared guild text channel to compare against — only VC membership matters.
// Async because a DM-originated interaction has no interaction.member (no
// guild context), so the member has to be fetched from the guild instead.
export async function checkInVoiceChannel(interaction, session) {
  const targetChannelId = session
    ? session.connection.joinConfig.channelId
    : interaction.member?.voice?.channelId
  if (!targetChannelId) return true

  let member = interaction.member
  if (!member) {
    const guild = interaction.client.guilds.cache.get(session.connection.joinConfig.guildId)
    member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null
  }

  const inVoice = member?.voice.channelId === targetChannelId
  if (!inVoice) {
    const payload = { content: '❌ ボイスチャンネルに参加してから操作してください', flags: MessageFlags.Ephemeral }
    if (interaction.deferred || interaction.replied) {
      interaction.followUp(payload)
    } else {
      interaction.reply(payload)
    }
    return false
  }
  return true
}
