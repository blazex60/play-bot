# music-bot

Discord VC で YouTube 音楽をストリーミング再生する Bot。

## 技術スタック

- Python 3.12+
- [py-cord](https://github.com/Pycord-Development/pycord) [voice] >= 2.6
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — YouTube 音声取得
- FFmpeg — 音声ストリーミング
- uv — パッケージ管理

## コマンド一覧

| コマンド | 説明 | 権限 |
|---|---|---|
| `/play <URL or キーワード>` | YouTube URL または検索キーワードで再生 | 全員 |
| `/pause` | 再生を一時停止 | VC 内のユーザーのみ |
| `/resume` | 再生を再開 | VC 内のユーザーのみ |
| `/skip` | 現在の曲をスキップ | VC 内のユーザーのみ |
| `/stop` | 再生停止 + キュークリア | VC 内のユーザーのみ |
| `/leave` | VC から退出 | 全員 |
| `/queue` | キュー一覧を表示 | 全員 |
| `/shuffle` | キューをシャッフル | VC 内のユーザーのみ |
| `/loop` | ループモード切り替え（オフ → 1曲 → キュー → オフ） | VC 内のユーザーのみ |
| `/nowplaying` | 現在再生中の曲を表示 | 全員 |

## セットアップ

### 1. `.env` を作成

```bash
cp .env.example .env
# .env を編集して DISCORD_TOKEN を設定
```

### 2. 依存関係インストール

```bash
uv sync
```

### 3. FFmpeg インストール（システム依存）

```bash
# Arch Linux
sudo pacman -S ffmpeg

# Ubuntu/Debian
sudo apt-get install ffmpeg
```

### 4. 起動

```bash
uv run python bot.py
```

## Docker で起動

```bash
cp .env.example .env
# .env を編集して DISCORD_TOKEN を設定
docker compose up --build
```

## 開発

```bash
# テスト
uv run pytest

# リント
uv run ruff check .

# フォーマット
uv run ruff format .
```

## 設計メモ

- **Lazy URL resolution** — googlevideo の音声 URL は数時間で失効するため、キュー追加時ではなく再生直前に毎回取得する
- **`asyncio.run_coroutine_threadsafe`** — py-cord の `after=` コールバックは別スレッドの同期関数のため必須
- **VC が空になったら自動退出** — `on_voice_state_update` でボット以外のメンバーが 0 人になったら切断
