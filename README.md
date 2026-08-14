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
| `music-web` | Fastify + React dashboard。Discord/YouTube OAuth、SQLite 書き込み、Bot API proxy | `127.0.0.1:${WEB_PORT}` |
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
| `/bitrate [kbps]` | VC のビットレートを設定（省略時は Boost tier 上限） | 全員 |
| `/normalize <enabled>` | Guild 単位の音量ノーマライズ on/off | 全員 |
| `/fade <enabled>` | Guild 単位の曲間フェード（クロスフェード）on/off。既定はオン | 全員 |
| `/autoplay mode/personalize/notify` | キュー枯渇時の自動再生モード・パーソナライズ・通知設定 | 全員 |
| `/help` | コマンド一覧を表示 | 全員 |

## セットアップ

```bash
cp .env.example .env
npm install
```

`.env` には Discord Bot token と application client ID に加え、Web UI 用の OAuth / session / internal API secret を設定する。MIX 機能を使う場合は `GEMINI_API_KEY`（任意で `GEMINI_MODEL`）を設定する。音声ミキサー移行中は `MIXER_ENABLED=true` のときだけ新ミキサー経路が有効になり、それ以外の値（未設定・`false` など）では従来の再生経路のままになる（詳細は `docs/mix-plan.md`）。

Provider console に登録する redirect URI:

| Provider | Redirect URI |
|---|---|
| Discord | `${PUBLIC_BASE_URL}/auth/discord/callback` or `DISCORD_OAUTH_REDIRECT` |
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

- `/`: public landing page
- `/dashboard`: now playing、pause/resume/skip/stop、autoplay/personalize、queue reorder/remove、YouTube playlist import、post-import match review、「My Playlists」保存済みプレイリスト管理
- `/admin`: guild 管理者向け(コマンド許可/拒否マトリクス、表示設定、操作ログ)。`extended` 権限が必要
- `/help`: コマンド一覧の詳細ヘルプ（公開ページ）
- `/login`: Discord OAuth login entry
- `/login/demo`: Google OAuth 審査担当者向けのパスワード保護デモログイン（`DEMO_LOGIN_ENABLED` 有効時のみ）
- `/callback/*`: OAuth callback completion screen for browser-side fallbacks

## セキュリティ境界

- `DISCORD_TOKEN`, OAuth client secrets, `WEB_SESSION_SECRET`, `BOT_API_TOKEN`, `MUSICBOT_TOKEN_ENC_KEY` は `.env` のみ
- MIX / Gemini 向け: `GEMINI_API_KEY`（必須時）、任意の `GEMINI_MODEL`、移行期間の `MIXER_ENABLED` も `.env` のみ（詳細は `docs/mix-plan.md`）
- Bot API は loopback + bearer token 前提で、Cloudflare Tunnel には出さない
- Web permissions は Bot API が Discord live voice state と実効管理者ロール（ギルド別 `/adminrole` 設定、未設定時は `ADMIN_ROLE_ID`）で判定する
- Gemini API は Web process から MIX の曲順補助・リクエスト文からのプレイリスト生成にのみ使う。送信は曲メタデータとリクエスト文に限定し、失敗しても再生は継続する

## Cloudflare Pages 法務ページ

`legal/` は利用規約・プライバシーポリシー公開用の静的サイト。Cloudflare Pages の Git integration でこのリポジトリを接続すると、`main` への push で自動更新できる。

公開ページ:

- `/` 法務文書一覧
- `/terms` 利用規約
- `/privacy` プライバシーポリシー

### Cloudflare Dashboard 設定

Cloudflare Dashboard で **Workers & Pages → Create application → Pages → Connect to Git** を選び、GitHub repository `blazex60/play-bot` を接続する。

Build settings は以下にする。

| 項目 | 値 |
|---|---|
| Project name | `music-bot-legal` |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | 空欄 |
| Build output directory | `legal` |
| Root directory | `/` または空欄 |

この設定では `legal/index.html`、`legal/terms.html`、`legal/privacy.html` がそのまま配信される。`legal/_headers` は Cloudflare Pages の静的ヘッダー設定として読み込まれる。

注意: Drag and drop / Direct Upload で作った Pages project は後から Git integration に切り替えられない。既にDirect Uploadで `music-bot-legal` を作成済みの場合は、その project を削除してGit連携で作り直すか、`music-bot-legal-git` など別名で新規作成する。

### カスタムドメイン設定

Google OAuth 同意画面のプライバシーポリシー URL とホームページ（`music.blazex60.com`）を同一ドメイン系列に揃えるため、`music-bot-legal` Pages project に `agreement.blazex60.com` をカスタムドメインとして割り当てる。

1. Cloudflare Dashboard → **Workers & Pages → music-bot-legal → Custom domains → Set up a custom domain**
2. `agreement.blazex60.com` を入力し、指示された CNAME を `blazex60.com` の DNS ゾーンに追加する（Cloudflare 管理下なら自動提案される）
3. 反映後、`https://agreement.blazex60.com/`・`/terms`・`/privacy` がそれぞれ開けることを確認する

この設定は Cloudflare Dashboard 側の操作が必要で、リポジトリの変更だけでは反映されない。設定後、`web/src/pages/Landing.jsx` のフッターリンクと Google OAuth 同意画面の「プライバシーポリシー URL」を `https://agreement.blazex60.com/privacy` に統一する。

### 更新方法

文面を更新したら `legal/terms.html` または `legal/privacy.html` を編集し、`main` に push する。

```bash
git add legal/index.html legal/terms.html legal/privacy.html legal/styles.css legal/_headers wrangler.jsonc README.md
git commit -m "Add legal pages for Cloudflare Pages"
git push origin main
```

Cloudflare Pages がリポジトリの変更を検知して自動デプロイする。

### ローカル確認

```bash
npx wrangler pages dev legal --port 8788
```

確認URL:

- `http://localhost:8788/terms`
- `http://localhost:8788/privacy`
