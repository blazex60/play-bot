# CLAUDE.md — music-bot

## 概要

Discord VC で YouTube 音楽をストリーミング再生する Bot。
discord.js v14 + @discordjs/voice + yt-dlp + FFmpeg で構成。LLM・外部 AI API は使用しない。

---

## 開発環境

| 項目 | 内容 |
|---|---|
| Runtime | Node.js >= 20 |
| パッケージ管理 | npm |
| Discord ライブラリ | discord.js v14 + @discordjs/voice |
| 音楽取得 | yt-dlp (child_process.spawn) |
| 音声処理 | FFmpeg |
| デプロイ | Docker Compose |

---

## よく使うコマンド

```bash
npm install
node src/deploy.js      # スラッシュコマンドを Discord に登録
node src/index.js       # Bot 起動
docker compose up --build
```

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/index.js` | Bot エントリーポイント（コマンドロード・イベント処理） |
| `src/sessions.js` | VC セッション共有状態（joinVoiceChannel・GuildQueue・GuildPlayer） |
| `src/player.js` | GuildPlayer（ウォッチドッグ・音量・ループ処理） |
| `src/queue.js` | GuildQueue（LoopMode: OFF/TRACK/QUEUE） |
| `src/search.js` | yt-dlp 連携（検索・メタデータ取得・ストリーム URL 解決） |
| `src/views.js` | 検索結果ボタン UI（ActionRowBuilder） |
| `src/commands/` | 12 個のスラッシュコマンド |
| `src/deploy.js` | スラッシュコマンド登録スクリプト |

---

## 設計上の制約

- **selfDeaf はネイティブ対応** — `joinVoiceChannel({ selfDeaf: true })` を使用。py-cord の close code 1000 問題を解消
- **ストリーム URL はキャッシュしない** — googlevideo URL は数時間で失効するため再生直前に `resolveStreamUrl()` で都度解決
- **AudioPlayerStatus.Idle イベント** — 曲終了後の次曲再生はこのイベントで駆動（スレッド問題なし）
- **ウォッチドッグ** — 10 秒ごとに再生状態を監視し、30 秒間停止状態が続いたら強制 stop
- **循環インポート防止** — `sessions.js` が共有状態を管理。`index.js` と `play.js` の双方向依存を排除
- **LLM 不使用** — 外部 AI API は一切使わない

## シークレット管理

- `DISCORD_TOKEN` / `CLIENT_ID` は必ず `.env` に書く
- ソースコードにシークレットを書かない
