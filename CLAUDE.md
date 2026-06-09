# CLAUDE.md — music-bot

## 概要

Discord VC で YouTube 音楽をストリーミング再生する Bot。
py-cord[voice] + yt-dlp + FFmpeg で構成。LLM・外部 AI API は使用しない。

---

## 開発環境

| 項目 | 内容 |
|---|---|
| Python | 3.12 |
| パッケージ管理 | `uv` |
| Discord ライブラリ | py-cord[voice] >= 2.6 |
| 音楽取得 | yt-dlp |
| 音声処理 | FFmpeg (apt install) |
| デプロイ | Docker Compose |

---

## よく使うコマンド

```bash
uv sync
uv run python bot.py
uv run pytest
uv run ruff check .
docker compose up --build
```

---

## 設計上の制約

- **音声ストリーム URL はキャッシュしない** — googlevideo URL は数時間で失効するため再生直前に `resolve_stream_url()` で都度解決
- **`asyncio.to_thread` 必須** — yt-dlp の `extract_info` はブロッキング処理
- **`asyncio.run_coroutine_threadsafe` 必須** — py-cord の `after=` コールバックは別スレッドから呼ばれる同期関数
- **`_force_skip` フラグ** — `/skip` × `LoopMode.TRACK` の競合を解消するフラグ
- **`on_disconnect` コールバック注入** — `_sessions` スコープは `bot.py` 内。`GuildPlayer` に `lambda gid: _sessions.pop(gid, None)` を渡す
- **LLM 不使用** — 外部 AI API は一切使わない

## シークレット管理

- `DISCORD_TOKEN` は必ず `.env` に書く
- `config.yaml` にシークレットを書かない
