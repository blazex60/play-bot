from __future__ import annotations

from unittest.mock import patch

import pytest

from search import YtdlpError, _sync_search, search_youtube


def _make_entry(video_id: str, title: str, duration: int = 180) -> dict:
    return {
        "id": video_id,
        "title": title,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "webpage_url": None,
        "duration": duration,
    }


def _make_ydl_result(entries: list[dict]) -> dict:
    return {"_type": "playlist", "entries": entries}


# ---------------------------------------------------------------------------
# _sync_search
# ---------------------------------------------------------------------------


def test_sync_search_uses_ytsearch5_prefix():
    """ytsearch5: prefix must be passed explicitly to extract_info."""
    fake_result = _make_ydl_result([_make_entry("abc123", "Test Song")])

    with patch("yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = fake_result

        results = _sync_search("test query")

        call_args = instance.extract_info.call_args
        assert call_args[0][0] == "ytsearch5:test query"
        assert len(results) == 1


def test_sync_search_filters_none_entries():
    fake_result = _make_ydl_result(
        [
            _make_entry("a", "Song A"),
            None,
            _make_entry("b", "Song B"),
        ]
    )

    with patch("yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = fake_result

        results = _sync_search("query")

    assert len(results) == 2
    assert all(r is not None for r in results)


def test_sync_search_returns_empty_on_none_result():
    with patch("yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = None

        results = _sync_search("query")

    assert results == []


# ---------------------------------------------------------------------------
# search_youtube (async)
# ---------------------------------------------------------------------------


async def test_search_youtube_returns_results():
    entries = [_make_entry("vid1", "Title 1"), _make_entry("vid2", "Title 2")]
    fake_result = _make_ydl_result(entries)

    with patch("yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.return_value = fake_result

        results = await search_youtube("some query")

    assert len(results) == 2
    assert results[0]["url"] == "https://www.youtube.com/watch?v=vid1"


async def test_search_youtube_raises_ytdlp_error_on_exception():
    with patch("yt_dlp.YoutubeDL") as MockYDL:
        instance = MockYDL.return_value.__enter__.return_value
        instance.extract_info.side_effect = Exception("network error")

        with pytest.raises(YtdlpError, match="Search failed"):
            await search_youtube("bad query")
