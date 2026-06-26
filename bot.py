from __future__ import annotations

import asyncio
import dataclasses
import logging
import os

import discord
import discord.voice.state as _voice_state
from dotenv import load_dotenv

from player import GuildPlayer
from queue_manager import GuildQueue, LoopMode
from search import YtdlpError, resolve_metadata, search_youtube
from views import SearchResultView

# Disable DAVE E2EE: when the `davey` package is installed py-cord advertises
# max_dave_protocol_version=1, causing Discord to initiate MLS key exchanges on
# every member join. py-cord's DAVE implementation is incomplete and drops audio
# for new members. Setting DAVE_PROTOCOL_VERSION=0 opts out entirely.
_voice_state.DAVE_PROTOCOL_VERSION = 0

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

bot = discord.Bot()

# ---------------------------------------------------------------------------
# Per-guild session
# ---------------------------------------------------------------------------


@dataclasses.dataclass
class GuildSession:
    voice_client: discord.VoiceClient
    queue: GuildQueue
    player: GuildPlayer


_sessions: dict[int, GuildSession] = {}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_LOOP_LABELS = {
    LoopMode.OFF: "オフ",
    LoopMode.TRACK: "1曲リピート",
    LoopMode.QUEUE: "キューリピート",
}

_BITRATE_BY_TIER: dict[int, int] = {0: 96_000, 1: 128_000, 2: 256_000, 3: 384_000}


def _fmt_duration(seconds: int | None) -> str:
    if seconds is None:
        return "不明"
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


async def _ensure_in_vc(
    ctx: discord.ApplicationContext,
) -> discord.VoiceChannel | None:
    if not ctx.author.voice or not ctx.author.voice.channel:
        await ctx.followup.send("❌ まずVCに参加してください", ephemeral=True)
        return None
    return ctx.author.voice.channel


async def _get_or_create_session(
    ctx: discord.ApplicationContext, channel: discord.VoiceChannel
) -> GuildSession:
    session = _sessions.get(ctx.guild_id)
    if session and session.voice_client.is_connected():
        return session
    vc = await channel.connect()
    # Deafen after connecting: py-cord's connect() lacks self_deaf; change_voice_state does it.
    await ctx.guild.change_voice_state(channel=vc.channel, self_deaf=True)
    queue = GuildQueue()
    loop = asyncio.get_running_loop()

    async def on_disconnect() -> None:
        s = _sessions.pop(ctx.guild_id, None)
        if s and s.voice_client.is_connected():
            await s.voice_client.disconnect()

    player = GuildPlayer(vc=vc, queue=queue, loop=loop, on_disconnect=on_disconnect)
    session = GuildSession(voice_client=vc, queue=queue, player=player)
    _sessions[ctx.guild_id] = session
    return session


# ---------------------------------------------------------------------------
# /play
# ---------------------------------------------------------------------------


@bot.slash_command(name="play", description="曲を再生します（URL or キーワード検索）")
async def cmd_play(
    ctx: discord.ApplicationContext,
    query: str = discord.Option(str, description="YouTube URL またはキーワード"),
) -> None:
    await ctx.defer()

    channel = await _ensure_in_vc(ctx)
    if channel is None:
        return

    # Check if it looks like a URL
    is_url = query.startswith("http://") or query.startswith("https://")

    if is_url:
        try:
            track = await resolve_metadata(query, requested_by=ctx.author.display_name)
        except YtdlpError as exc:
            await ctx.followup.send(f"❌ 取得に失敗しました: {exc}", ephemeral=True)
            return

        session = await _get_or_create_session(ctx, channel)
        was_empty = session.queue.is_empty
        session.queue.add(track)

        await ctx.followup.send(
            f"✅ キューに追加しました: **{track.title}** ({_fmt_duration(track.duration)})"
        )

        if was_empty:
            await session.player.play_next()
    else:
        # Keyword search
        try:
            results = await search_youtube(query)
        except YtdlpError as exc:
            await ctx.followup.send(f"❌ 検索に失敗しました: {exc}", ephemeral=True)
            return

        if not results:
            await ctx.followup.send("❌ 検索結果が見つかりませんでした", ephemeral=True)
            return

        async def on_select(entry: dict) -> None:
            webpage_url = entry.get("url") or entry.get("webpage_url") or ""
            if not webpage_url:
                await ctx.followup.send("❌ URLを取得できませんでした", ephemeral=True)
                return
            try:
                track = await resolve_metadata(webpage_url, requested_by=ctx.author.display_name)
            except YtdlpError as exc:
                await ctx.followup.send(f"❌ 取得に失敗しました: {exc}", ephemeral=True)
                return

            session = await _get_or_create_session(ctx, channel)
            was_empty = session.queue.is_empty
            session.queue.add(track)

            await ctx.followup.send(
                f"✅ キューに追加しました: **{track.title}** ({_fmt_duration(track.duration)})"
            )

            if was_empty:
                await session.player.play_next()

        view = SearchResultView(results, on_select)
        await ctx.followup.send("🔍 検索結果:", view=view)


# ---------------------------------------------------------------------------
# /pause  /resume  /skip  /stop  /leave
# ---------------------------------------------------------------------------


@bot.slash_command(name="pause", description="再生を一時停止します")
async def cmd_pause(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    if session.player.pause():
        await ctx.respond("⏸️ 一時停止しました")
    else:
        await ctx.respond("❌ 現在再生中ではありません", ephemeral=True)


@bot.slash_command(name="resume", description="再生を再開します")
async def cmd_resume(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    if session.player.resume():
        await ctx.respond("▶️ 再生を再開しました")
    else:
        await ctx.respond("❌ 一時停止中ではありません", ephemeral=True)


@bot.slash_command(name="skip", description="現在の曲をスキップします")
async def cmd_skip(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    track = session.queue.current
    await session.player.skip()
    title = track.title if track else "不明"
    await ctx.respond(f"⏭️ スキップしました: **{title}**")


@bot.slash_command(name="stop", description="再生を停止してキューをクリアします")
async def cmd_stop(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    await session.player.stop()
    await ctx.respond("⏹️ 再生を停止してキューをクリアしました")


@bot.slash_command(name="leave", description="ボットをVCから退出させます")
async def cmd_leave(ctx: discord.ApplicationContext) -> None:
    session = _sessions.pop(ctx.guild_id, None)
    if not session:
        await ctx.respond("❌ ボットはVCにいません", ephemeral=True)
        return
    if session.voice_client.is_connected():
        await session.voice_client.disconnect()
    await ctx.respond("👋 VCから退出しました")


# ---------------------------------------------------------------------------
# /queue  /shuffle  /loop  /volume  /nowplaying
# ---------------------------------------------------------------------------


@bot.slash_command(name="queue", description="現在のキューを表示します")
async def cmd_queue(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session or session.queue.is_empty:
        await ctx.respond("📭 キューは空です", ephemeral=True)
        return

    current = session.queue.current
    upcoming = session.queue.upcoming()

    lines = []
    if current:
        lines.append(f"**▶ 再生中:** {current.title} ({_fmt_duration(current.duration)})")
    if upcoming:
        lines.append("**次の曲:**")
        for i, t in enumerate(upcoming[:10], start=1):
            lines.append(f"  {i}. {t.title} ({_fmt_duration(t.duration)})")
        if len(upcoming) > 10:
            lines.append(f"  … 他{len(upcoming) - 10}曲")

    loop_label = _LOOP_LABELS[session.queue.loop_mode]
    lines.append(f"\nループ: {loop_label}")

    await ctx.respond("\n".join(lines))


@bot.slash_command(name="shuffle", description="キューをシャッフルします")
async def cmd_shuffle(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session or session.queue.is_empty:
        await ctx.respond("❌ キューが空です", ephemeral=True)
        return
    session.queue.shuffle()
    await ctx.respond("🔀 キューをシャッフルしました")


@bot.slash_command(name="loop", description="ループモードを切り替えます（オフ→1曲→キュー→オフ）")
async def cmd_loop(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    new_mode = session.queue.cycle_loop()
    label = _LOOP_LABELS[new_mode]
    await ctx.respond(f"🔁 ループモード: **{label}**")


@bot.slash_command(name="volume", description="音量を設定します（0〜200）")
async def cmd_volume(
    ctx: discord.ApplicationContext,
    level: int = discord.Option(int, description="音量 0〜200", min_value=0, max_value=200),
) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    session.player.set_volume(level / 100.0)
    await ctx.respond(f"🔊 音量を {level}% に設定しました")


@bot.slash_command(
    name="bitrate", description="VCのビットレートを設定します（省略時はサーバー最大値）"
)
async def cmd_bitrate(
    ctx: discord.ApplicationContext,
    kbps: int | None = discord.Option(
        int,
        description="ビットレート (kbps)。省略するとサーバー最大値を設定",
        min_value=8,
        required=False,
        default=None,
    ),
) -> None:
    await ctx.defer()
    channel = await _ensure_in_vc(ctx)
    if channel is None:
        return
    tier = ctx.guild.premium_tier
    max_bitrate = _BITRATE_BY_TIER.get(tier, 96_000)
    target = max_bitrate if kbps is None else min(kbps * 1000, max_bitrate)
    try:
        await channel.edit(bitrate=target)
    except discord.Forbidden:
        await ctx.followup.send("❌ チャンネルの編集権限がありません", ephemeral=True)
        return
    suffix = f"（Tier{tier} 上限に丸めました）" if kbps is not None and target < kbps * 1000 else ""
    await ctx.followup.send(f"✅ ビットレートを **{target // 1000}kbps** に設定しました{suffix}")


@bot.slash_command(name="nowplaying", description="現在再生中の曲を表示します")
async def cmd_nowplaying(ctx: discord.ApplicationContext) -> None:
    session = _sessions.get(ctx.guild_id)
    if not session:
        await ctx.respond("❌ 再生中の曲がありません", ephemeral=True)
        return
    track = session.queue.current
    if not track:
        await ctx.respond("📭 現在再生中の曲はありません", ephemeral=True)
        return

    embed = discord.Embed(title="🎵 Now Playing", color=discord.Color.blurple())
    embed.add_field(name="タイトル", value=track.title, inline=False)
    embed.add_field(name="長さ", value=_fmt_duration(track.duration), inline=True)
    embed.add_field(name="リクエスト", value=track.requested_by, inline=True)
    loop_label = _LOOP_LABELS[session.queue.loop_mode]
    embed.add_field(name="ループ", value=loop_label, inline=True)
    if track.thumbnail:
        embed.set_thumbnail(url=track.thumbnail)

    await ctx.respond(embed=embed)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


@bot.event
async def on_ready() -> None:
    logger.info("Bot ready: %s (id=%s)", bot.user, bot.user.id)


@bot.event
async def on_voice_state_update(
    member: discord.Member,
    before: discord.VoiceState,
    after: discord.VoiceState,
) -> None:
    if member.id == bot.user.id:
        return

    session = _sessions.get(member.guild.id)
    if not session or not session.voice_client.is_connected():
        return

    bot_channel = session.voice_client.channel
    if before.channel != bot_channel:
        return

    # Check if any non-bot members remain
    human_members = [m for m in bot_channel.members if not m.bot]
    if not human_members:
        logger.info("All humans left %s, auto-disconnecting", bot_channel.name)
        s = _sessions.pop(member.guild.id, None)
        if s:
            if s.voice_client.is_playing() or s.voice_client.is_paused():
                s.voice_client.stop()
            if s.voice_client.is_connected():
                await s.voice_client.disconnect()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    bot.run(os.environ["DISCORD_TOKEN"])
