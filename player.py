from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine

import discord

from queue_manager import GuildQueue, LoopMode
from search import YtdlpError, resolve_stream_url

logger = logging.getLogger(__name__)

FFMPEG_OPTIONS: dict[str, str] = {
    "before_options": (
        "-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -reconnect_at_eof 1"
    ),
    "options": "-vn",
}

_WATCHDOG_INTERVAL = 10.0
_STALL_TIMEOUT = 30.0
_DURATION_BUFFER = 10.0  # seconds past expected duration before treating as loop
_RECONNECT_GRACE = 5.0  # playback ending this quickly implies VC reconnect interrupted it


class _WatchdogSource(discord.PCMVolumeTransformer):
    """PCMVolumeTransformer that tracks when audio data was last produced."""

    def __init__(self, source: discord.AudioSource, volume: float) -> None:
        super().__init__(source, volume=volume)
        self._last_read_at: float = time.monotonic()

    def read(self) -> bytes:
        data = super().read()
        if data:
            self._last_read_at = time.monotonic()
        return data

    @property
    def last_read_at(self) -> float:
        return self._last_read_at


class GuildPlayer:
    """Manages playback for a single guild."""

    def __init__(
        self,
        vc: discord.VoiceClient,
        queue: GuildQueue,
        loop: asyncio.AbstractEventLoop,
        on_disconnect: Callable[[], Coroutine[Any, Any, None]],
    ) -> None:
        self._vc = vc
        self._queue = queue
        self._loop = loop
        self._on_disconnect = on_disconnect
        self._lock = asyncio.Lock()
        self._force_skip = False
        self._volume = 1.0
        self._watchdog_task: asyncio.Task | None = None
        self._playback_start: float = 0.0

    # ------------------------------------------------------------------
    # Core playback
    # ------------------------------------------------------------------

    async def play_next(self) -> None:
        """Resolve stream URL and start playback for the current track."""
        # Poll OUTSIDE the lock: holding _lock during sleep would deadlock via
        # watchdog -> _vc.stop() -> _after -> _handle_after -> play_next -> lock wait.
        if not self._vc.is_connected():
            logger.info("VC not connected; waiting up to 10s for reconnect...")
            for _ in range(10):
                await asyncio.sleep(1.0)
                if self._vc.is_connected():
                    break
            else:
                await self._on_disconnect()
                return

        async with self._lock:
            while True:
                track = self._queue.current
                if track is None:
                    await self._on_disconnect()
                    return

                try:
                    stream_url = await resolve_stream_url(track.webpage_url)
                except YtdlpError as exc:
                    logger.warning("Stream resolution failed for %s: %s", track.title, exc)
                    if self._queue.next(force_advance=True) is None:
                        await self._on_disconnect()
                        return
                    continue

                break

            source = discord.FFmpegPCMAudio(stream_url, **FFMPEG_OPTIONS)
            monitored = _WatchdogSource(source, volume=self._volume)

            def _after(error: Exception | None) -> None:
                if error:
                    logger.error("Playback error: %s", error)
                asyncio.run_coroutine_threadsafe(self._handle_after(), self._loop)

            if self._watchdog_task and not self._watchdog_task.done():
                self._watchdog_task.cancel()
            self._playback_start = time.monotonic()
            try:
                self._vc.play(monitored, after=_after)
            except discord.ClientException as exc:
                logger.warning("Could not start playback (VC disconnected): %s", exc)
                await self._on_disconnect()
                return
            self._watchdog_task = asyncio.create_task(self._watchdog(monitored, track.duration))

    async def _watchdog(self, source: _WatchdogSource, duration: int | None) -> None:
        """Detect stalled or looping playback and force-advance the queue."""
        start = time.monotonic()
        while True:
            await asyncio.sleep(_WATCHDOG_INTERVAL)
            if not self._vc.is_playing():
                break
            elapsed = time.monotonic() - start
            if duration is not None and elapsed > duration + _DURATION_BUFFER:
                logger.info(
                    "Playback exceeded track duration (%.0fs elapsed, %ds expected). Advancing.",
                    elapsed,
                    duration,
                )
                self._vc.stop()
                break
            stale = time.monotonic() - source.last_read_at
            if stale >= _STALL_TIMEOUT:
                logger.warning("Playback stalled (%.0fs no audio). Force-stopping.", stale)
                self._vc.stop()
                break

    async def _handle_after(self) -> None:
        """Called from the after= callback via run_coroutine_threadsafe."""
        force = self._force_skip
        self._force_skip = False

        elapsed = time.monotonic() - self._playback_start
        if not force and elapsed < _RECONNECT_GRACE:
            track = self._queue.current
            track_is_short = (
                track is not None
                and track.duration is not None
                and track.duration < _RECONNECT_GRACE
            )
            if not track_is_short:
                logger.info(
                    "Playback ended after %.1fs (< %.0fs grace); "
                    "assuming gateway/voice reconnect — retrying current track.",
                    elapsed,
                    _RECONNECT_GRACE,
                )
                await asyncio.sleep(2.0)
                await self.play_next()
                return

        next_track = self._queue.next(force_advance=force)
        if next_track is None:
            await self._on_disconnect()
        else:
            await self.play_next()

    # ------------------------------------------------------------------
    # Controls
    # ------------------------------------------------------------------

    def pause(self) -> bool:
        """Pause playback. Returns True if paused successfully."""
        if self._vc.is_playing():
            self._vc.pause()
            return True
        return False

    def resume(self) -> bool:
        """Resume paused playback. Returns True if resumed successfully."""
        if self._vc.is_paused():
            self._vc.resume()
            return True
        return False

    async def skip(self) -> None:
        """Skip the current track."""
        self._force_skip = True
        if self._vc.is_playing() or self._vc.is_paused():
            self._vc.stop()
        else:
            # Not playing: manually advance
            next_track = self._queue.next(force_advance=True)
            if next_track is None:
                await self._on_disconnect()
            else:
                await self.play_next()

    async def stop(self) -> None:
        """Stop playback and clear the queue."""
        self._queue.clear()
        self._force_skip = True
        if self._vc.is_playing() or self._vc.is_paused():
            self._vc.stop()

    def set_volume(self, volume: float) -> None:
        """Set volume in range [0.0, 2.0]."""
        self._volume = max(0.0, min(2.0, volume))
        if self._vc.source and isinstance(self._vc.source, discord.PCMVolumeTransformer):
            self._vc.source.volume = self._volume

    @property
    def is_playing(self) -> bool:
        return self._vc.is_playing()

    @property
    def is_paused(self) -> bool:
        return self._vc.is_paused()

    @property
    def loop_mode(self) -> LoopMode:
        return self._queue.loop_mode
