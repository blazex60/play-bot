import { MessageFlags } from 'discord.js'

export function checkSameVoiceChannel(interaction, session) {
  if (session && interaction.member.voice.channelId !== session.connection.joinConfig.channelId) {
    interaction.reply({ content: '❌ 同じボイスチャンネルに参加してから操作してください', flags: MessageFlags.Ephemeral })
    return false
  }
  return true
}
