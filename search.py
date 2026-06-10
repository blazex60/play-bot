from __future__ import annotations

import asyncio
from typing import Any

import yt_dlp

from queue_manager import Track

# ---------------------------------------------------------------------------
# yt-dlp option presets
# ---------------------------------------------------------------------------

YDL_OPTS_SEARCH: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "extract_flat": True,
    "skip_download": True,
}

YDL_OPTS_STREAM: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "format": "bestaudio/best",
    "noplaylist": True,
    "skip_download": True,
}


# ---------------------------------------------------------------------------
# Error
# ---------------------------------------------------------------------------


class YtdlpError(Exception):
    """Raised when yt-dlp fails to fetch information."""


# ---------------------------------------------------------------------------
# Internal sync helpers (run inside asyncio.to_thread)
# ---------------------------------------------------------------------------


def _sync_search(query: str) -> list[dict[str, Any]]:
    with yt_dlp.YoutubeDL(YDL_OPTS_SEARCH) as ydl:
        result = ydl.extract_info(f"ytsearch5:{query}", download=False)
    if result is None:
        return []
    entries: list[dict[str, Any]] = result.get("entries", [])
    return [e for e in entries if e is not None]


def _sync_resolve_stream(url: str) -> str:
    with yt_dlp.YoutubeDL(YDL_OPTS_STREAM) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise YtdlpError(f"Could not resolve stream URL for: {url}")
    stream_url: str | None = info.get("url")
    if not stream_url:
        # Some formats store the URL inside the formats list
        for fmt in info.get("formats", []):
            candidate = fmt.get("url")
            if candidate:
                stream_url = candidate
                break
    if not stream_url:
        raise YtdlpError(f"No stream URL found for: {url}")
    return stream_url


def _sync_resolve_metadata(url: str) -> dict[str, Any]:
    with yt_dlp.YoutubeDL(YDL_OPTS_STREAM) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise YtdlpError(f"Could not resolve metadata for: {url}")
    return info


# ---------------------------------------------------------------------------
# Public async API
# ---------------------------------------------------------------------------


async def search_youtube(query: str) -> list[dict[str, Any]]:
    """Search YouTube and return up to 5 result dicts (flat metadata)."""
    try:
        return await asyncio.to_thread(_sync_search, query)
    except Exception as exc:
        raise YtdlpError(f"Search failed: {exc}") from exc


async def resolve_stream_url(webpage_url: str) -> str:
    """Resolve a direct audio stream URL from a webpage URL."""
    try:
        return await asyncio.to_thread(_sync_resolve_stream, webpage_url)
    except YtdlpError:
        raise
    except Exception as exc:
        raise YtdlpError(f"Stream resolution failed: {exc}") from exc


async def resolve_metadata(url: str, requested_by: str) -> Track:
    """Fetch full metadata for *url* and return a Track (no stream URL stored)."""
    try:
        info = await asyncio.to_thread(_sync_resolve_metadata, url)
    except YtdlpError:
        raise
    except Exception as exc:
        raise YtdlpError(f"Metadata resolution failed: {exc}") from exc

    return Track(
        webpage_url=info.get("webpage_url") or url,
        title=info.get("title") or url,
        duration=info.get("duration"),
        thumbnail=info.get("thumbnail"),
        requested_by=requested_by,
    )
