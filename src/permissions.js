import { MessageFlags } from 'discord.js'

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
