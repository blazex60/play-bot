import { MessageFlags } from 'discord.js'
import { resolveCommandPermission, getCommandVisibilitySettings } from './settings.js'

// Historical hardcoded reply visibility, kept as the fallback for any guild
// that hasn't customized a given command via the admin dashboard yet.
const DEFAULT_VISIBILITY = {
  help: 'personal',
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
  mix: 'personal',
}

// Commands that manage the admin-role gate itself must not appear in the
// allow/deny or public/personal matrices — otherwise the delegated web-admin
// role could deny `/adminrole` and lock Discord Administrators out of
// changing or revoking that role. These commands enforce their own auth
// (Discord Administrator) and always reply ephemerally.
export const MATRIX_EXCLUDED_COMMANDS = new Set(['adminrole'])

export function isMatrixManagedCommand(commandName) {
  return Boolean(commandName) && !MATRIX_EXCLUDED_COMMANDS.has(commandName)
}

// Whether the member (has adminRoleId) should bypass a command's allow/deny
// setting entirely, so an admin can never lock themselves out.
function hasAdminRole(member, adminRoleId) {
  return Boolean(adminRoleId && member?.roles?.cache?.has?.(adminRoleId))
}

// commandName defaults to the slash command being invoked, but callers that
// gate a *component* interaction belonging to a command (e.g. the /queue
// editor's buttons) must pass it explicitly — button/select/modal
// interactions have no interaction.commandName of their own, so without an
// explicit override a denied user's queue-editor clicks would silently skip
// the permission check entirely. guildId likewise defaults to
// interaction.guildId but must be passed explicitly for DM-originated
// interactions (e.g. autoplay recommendation picks), which have no guild
// context of their own. member defaults to interaction.member for the same
// reason — a DM interaction has none, so the admin-role bypass would
// otherwise silently fail for every DM-originated check; callers with a DM
// interaction must resolve the live guild member themselves (mirroring
// checkInVoiceChannel's own guild.members.fetch fallback below) and pass it.
export function checkCommandAllowed(interaction, adminRoleId, commandName = interaction.commandName, guildId = interaction.guildId, member = interaction.member) {
  // Privileged setup commands skip the matrix entirely; their handlers do
  // their own Discord-Administrator check so a denied matrix entry can never
  // strand server owners without a way to reconfigure the admin role.
  if (MATRIX_EXCLUDED_COMMANDS.has(commandName)) return true
  if (hasAdminRole(member, adminRoleId)) return true
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

// Sends a message whose visibility must reflect `targetFlags`, after an
// interaction that has already been deferred/replied. Discord ignores the
// `flags` passed to the *first* followUp message sent for an interaction —
// it always inherits the original response's ephemeral state
// (discord/discord-api-docs#3466) — regardless of which way the mismatch
// goes. `interaction.ephemeral` (set by discord.js from the original
// deferReply/reply flags) tells us that actual state. When targetFlags
// already matches it, a plain followUp is enough; otherwise a throwaway
// followUp matching the original state is burned first (then deleted) so
// the real message lands as the *second* followUp, which is free to set its
// own visibility.
export async function sendVisibleFollowUp(interaction, content, targetFlags) {
  const wantsEphemeral = Boolean(targetFlags.flags)
  if (wantsEphemeral === interaction.ephemeral) {
    return interaction.followUp({ content, ...targetFlags })
  }
  const throwawayFlags = interaction.ephemeral ? { flags: MessageFlags.Ephemeral } : {}
  const throwaway = await interaction.followUp({ content: '\u200B', ...throwawayFlags })
  await interaction.deleteReply(throwaway.id).catch(() => {})
  return interaction.followUp({ content, ...targetFlags })
}

// Shared guard for the common "fetch this guild's session, bail out with an
// ephemeral reply if there isn't one (or isEmpty(session) says it doesn't
// count), then require same-VC/-text-channel" shape repeated across most VC
// commands (pause/resume/skip/stop/loop/leave/shuffle). Returns the session
// on success, or `false` after already having replied. skipVoiceCheck lets
// callers that don't gate on VC membership (e.g. /nowplaying) reuse just the
// session-presence half.
export async function requireSessionInSameVoice(interaction, sessions, { emptyMessage, isEmpty = () => false, skipVoiceCheck = false } = {}) {
  const session = sessions.get(interaction.guildId)
  if (!session || isEmpty(session)) {
    await interaction.reply({ content: emptyMessage, flags: MessageFlags.Ephemeral })
    return false
  }
  if (!skipVoiceCheck && !checkSameVoiceChannel(interaction, session)) return false
  return session
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
// guild context), so the member has to be fetched from the guild instead —
// unless the caller already resolved one (e.g. to reuse it for a preceding
// checkCommandAllowed call too), in which case that fetch is skipped.
export async function checkInVoiceChannel(interaction, session, resolvedMember = interaction.member) {
  const targetChannelId = session
    ? session.connection.joinConfig.channelId
    : resolvedMember?.voice?.channelId
  if (!targetChannelId) return true

  let member = resolvedMember
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
