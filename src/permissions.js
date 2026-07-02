import { MessageFlags } from 'discord.js'

export function checkSameVoiceChannel(interaction, session) {
  if (!session) return true
  const botChannelId = session.connection.joinConfig.channelId
  const inVoice = interaction.member.voice.channelId === botChannelId
  const inChat = interaction.channelId === botChannelId
  if (!inVoice || !inChat) {
    interaction.reply({ content: '❌ 参加しているボイスチャンネルのチャットから操作してください', flags: MessageFlags.Ephemeral })
    return false
  }
  return true
}
