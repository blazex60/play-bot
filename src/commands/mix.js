import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { requireSessionInSameVoice, replyFlags } from '../permissions.js';
import { trackIdentity } from '../queue.js';
import { webClient } from '../sessions.js';

export default {
  data: new SlashCommandBuilder()
    .setName('mix')
    .setDescription('MIX プレイリスト機能')
    .addSubcommand((sub) =>
      sub
        .setName('order')
        .setDescription('キューの残り曲を BPM/キーに基づいて並べ替えます'),
    ),

  async execute(interaction, sessions) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== 'order') return false;

    const session = await requireSessionInSameVoice(interaction, sessions, {
      emptyMessage: '❌ 再生中の曲がありません',
      isEmpty: (s) => !s.queue.current,
    });
    if (!session) return false;

    const upcoming = session.queue.upcoming();
    if (upcoming.length < 2) {
      await interaction.reply({
        content: '❌ 並べ替えるには upcoming が2曲以上必要です',
        flags: MessageFlags.Ephemeral,
      });
      return false;
    }

    await interaction.deferReply(replyFlags(interaction.guildId, 'mix'));

    const snapshotIds = upcoming.map(trackIdentity);
    const current = session.queue.current;
    const result = await webClient.optimizeOrder({
      guildId: interaction.guildId,
      anchorVideoId: current?.videoId ?? null,
      tracks: upcoming.map((track) => ({
        videoId: track.videoId,
        title: track.title,
        channel: track.channel,
        duration: track.duration,
      })),
    });

    if (!result?.order) {
      await interaction.editReply({ content: '❌ 曲順の最適化に失敗しました（解析データ不足の可能性があります）' });
      return false;
    }

    const ok = session.queue.reorderUpcomingIfUnchanged(result.order, snapshotIds);
    if (!ok) {
      await interaction.editReply({ content: '❌ 最適化中にキューが変更されたため並べ替えを中止しました' });
      return false;
    }

    // Subcommand-specific audit row; return null so the dispatcher does not
    // also insert a generic `mix` success (see src/index.js deferred-outcome).
    await webClient.logOperation({
      guildId: interaction.guildId,
      discordUserId: interaction.user.id,
      username: interaction.member?.displayName ?? interaction.user.username,
      source: 'command',
      action: 'mix:order',
      detail: JSON.stringify({ count: upcoming.length, source: result.source ?? 'algorithm' }),
      success: true,
    });

    const label = result.source === 'gemini' ? '（Gemini 補助）' : '';
    await interaction.editReply({
      content: `🎚️ ${interaction.member.displayName} が upcoming ${upcoming.length} 曲を MIX 向けに並べ替えました${label}`,
    });
    return null;
  },
};
