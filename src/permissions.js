import { MessageFlags } from 'discord.js'

export function checkSameVoiceChannel(interaction, session) {
  if (!session) return true
  const botChannelId = session.connection.joinConfig.channelId
  const inVoice = interaction.member.voice.channelId === botChannelId
  const inChat = interaction.channelId === botChannelId
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
