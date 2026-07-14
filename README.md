# music-bot

Discord VC で YouTube 音楽をストリーミング再生し、Web UI から再生操作と外部プレイリスト取り込みを行う Bot。

## 技術スタック

- Node.js >= 20
- discord.js v14 + @discordjs/voice
- yt-dlp + FFmpeg
- Fastify Web server
- React + Vite dashboard
- better-sqlite3 for web sessions, OAuth state, encrypted service tokens, and import history

## アーキテクチャ

Compose は同じ Docker image から 3 つの process/service を起動する。

| Service | Role | Exposure |
|---|---|---|
| `music-bot` | Discord Bot runtime。VC 接続、再生、キュー、Bot internal API を保持 | `127.0.0.1:${BOT_API_PORT}` only |
| `music-web` | Fastify + React dashboard。Discord/Spotify/YouTube OAuth、SQLite 書き込み、Bot API proxy | `127.0.0.1:${WEB_PORT}` |
| `cloudflared` | Cloudflare Tunnel | `WEB_PORT` のみ。Bot API port は tunnel しない |

Bot process は SQLite を開かない。ライブ状態は Bot process の `sessions` / `GuildPlayer` / `GuildQueue` が保持し、Web process は `BOT_API_TOKEN` 付きの loopback HTTP で操作する。SQLite は Web process の永続データ専用。

## コマンド一覧

| コマンド | 説明 | 権限 |
|---|---|---|
| `/play <URL or キーワード>` | YouTube URL（プレイリスト対応）または検索キーワードで再生 | 全員 |
| `/pause` | 再生を一時停止 | VC 内のユーザーのみ |
| `/resume` | 再生を再開 | VC 内のユーザーのみ |
| `/skip` | 現在の曲をスキップ | VC 内のユーザーのみ |
| `/stop` | 再生停止 + キュークリア | VC 内のユーザーのみ |
| `/leave` | VC から退出 | 全員 |
| `/queue` | キュー一覧を表示 | 全員 |
| `/shuffle` | キューをシャッフル | VC 内のユーザーのみ |
| `/loop` | ループモード切り替え（オフ -> 1曲 -> キュー -> オフ） | VC 内のユーザーのみ |
| `/nowplaying` | 現在再生中の曲を表示 | 全員 |

## セットアップ

```bash
cp .env.example .env
npm install
```

`.env` には Discord Bot token と application client ID に加え、Web UI 用の OAuth / session / internal API secret を設定する。

Provider console に登録する redirect URI:

| Provider | Redirect URI |
|---|---|
| Discord | `${PUBLIC_BASE_URL}/auth/discord/callback` or `DISCORD_OAUTH_REDIRECT` |
| Spotify | `${PUBLIC_BASE_URL}/auth/spotify/callback` |
| Google / YouTube | `${PUBLIC_BASE_URL}/auth/youtube/callback` |

`MUSICBOT_TOKEN_ENC_KEY` は 32-byte base64 key を使う。紛失すると保存済み OAuth token は復号できない。

## ローカル開発

```bash
npm run deploy
npm start
npm run build:web
npm run test:web
npm run test:e2e
npm run check
```

Web UI の React dev server はテスト時に Playwright config が起動する。production では `music-web` が `web/dist` を Fastify static として配信する。

## Docker で起動

```bash
cp .env.example .env
docker compose up --build
```

`network_mode: "host"` は Discord voice UDP のため必須。Linux host 前提。

## Web UI

- `/` dashboard: now playing、pause/resume/skip/stop、volume、queue reorder/remove、playlist import、post-import match review
- `/login`: Discord OAuth login entry
- `/callback/*`: OAuth callback completion screen for browser-side fallbacks

Apple Music は phase 2 のため、UI では disabled の「準備中」として表示する。

## セキュリティ境界

- `DISCORD_TOKEN`, OAuth client secrets, `WEB_SESSION_SECRET`, `BOT_API_TOKEN`, `MUSICBOT_TOKEN_ENC_KEY` は `.env` のみ
- Bot API は loopback + bearer token 前提で、Cloudflare Tunnel には出さない
- Web permissions は Bot API が Discord live voice state と `ADMIN_ROLE_ID` で判定する
- 外部 AI API は使用しない
