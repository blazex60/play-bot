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
