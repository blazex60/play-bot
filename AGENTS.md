<!-- Generated: 2026-07-15 | Updated: 2026-08-11 -->

# music-bot

## Purpose

Discord VC で YouTube 音楽をストリーミング再生する Bot。discord.js v14 + @discordjs/voice + yt-dlp + FFmpeg で音声を処理し、Fastify + React の Web ダッシュボードから再生操作と YouTube プレイリスト取り込みを行える(Spotify/Apple Music は削除済み — 詳細は `CLAUDE.md` の「Web UI scope」参照)。MIX 機能では Google Gemini API を Web process（`src/web/server/services/gemini.js`）から利用する（曲順補助・リクエスト文からのプレイリスト生成。失敗時も再生は継続）。詳細は `docs/mix-plan.md` と `CLAUDE.md` の「Gemini / MIX」。`legal/` は同じリポジトリで管理する Cloudflare Pages 向けの独立した静的法務ページ（利用規約・プライバシーポリシー）。

## Key Files

| File | Description |
|------|--------------|
| `package.json` | npm scripts（`start`/`deploy`/`test:*`/`build:web`/`check`）と依存関係定義 |
| `docker-compose.yml` | `music-bot` / `music-web` / `cloudflared` の 3 service 構成。`network_mode: host` が Discord voice UDP のため必須 |
| `Dockerfile` | 3 service 共通の単一 image ビルド定義 |
| `wrangler.jsonc` | `legal/` を Cloudflare Pages にデプロイするための Wrangler 設定（`pages_build_output_dir: ./legal`） |
| `README.md` | セットアップ手順、アーキテクチャ表、Cloudflare Pages 法務ページの運用手順 |
| `CLAUDE.md` | 音声実装・Web UI アーキテクチャ・設計上の制約に関する詳細な開発者向けドキュメント（このファイルより優先して参照すること） |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | Bot 本体（Discord client、VC 接続、スラッシュコマンド、Web process 用の内部 API）と SQLite 層（`src/db/`）、Web server（`src/web/`）（see `src/AGENTS.md`） |
| `web/` | React + Vite 製の Web ダッシュボード SPA。`music-web` process が `web/dist` をビルド成果物として配信する（see `web/AGENTS.md`） |
| `scripts/` | ビルド・QA 用の Node スクリプト群（web ビルド、テストランナー、QA manifest 実行） (see `scripts/AGENTS.md`) |
| `test/` | ブラウザ E2E テスト（Playwright）と QA タスクランナーのテスト（see `test/AGENTS.md`） |
| `legal/` | Cloudflare Pages で配信する利用規約・プライバシーポリシーの静的サイト。npm プロジェクトとは独立（see `legal/AGENTS.md`） |
| `.github/workflows/` | Tailscale 経由 SSH で本番ホストに `docker compose up --build -d` する deploy workflow (see `.github/workflows/AGENTS.md`) |
| `data/` | SQLite DB (`musicbot.db`) と guild 設定 JSON の永続化先。`.gitignore` 対象、空ディレクトリなので AGENTS.md なし |

## For AI Agents

### Working In This Directory
- 音声・OAuth・Web アーキテクチャの制約は `CLAUDE.md` に集約されている。実装前に必ず読むこと（`network_mode: host` 必須、`@discordjs/voice` バージョン制約、yt-dlp stdout パイプ方式、ウォッチドッグのロジックなど）
- MIX / Gemini の範囲と失敗時挙動は `CLAUDE.md` の「Gemini / MIX」および `docs/mix-plan.md` を参照。Gemini は Web process のみ。再生経路を Gemini 失敗で止めないこと
- Bot process（`src/index.js` 系）は SQLite を一切開かない。DB は Web process（`src/web/server/`）専用。この境界を壊さないこと
- Bot API（`src/botApi.js`）は loopback (`127.0.0.1:${BOT_API_PORT}`) 限定で bearer token 必須。Cloudflare Tunnel には絶対に出さない
- シークレットは全て `.env` のみ（`GEMINI_API_KEY` 含む）。ソースコードに書かない
- `legal/` はこのリポジトリの npm/Node プロジェクトとは無関係の独立した静的サイトで、別の Cloudflare Pages project としてデプロイされる

### Testing Requirements
```bash
npm run test:server    # Node 標準 test runner（src/, scripts/ 配下の *.test.js）
npm run test:web       # vitest（web/ 配下）
npm run test:e2e       # Playwright（test/browser/）
npm run typecheck      # tsc --noEmit（web/tsconfig.json）
npm run check          # 上記一式 + build:web
```

### Common Patterns
- ES Modules（`"type": "module"`）。CommonJS 記法は使わない
- スラッシュコマンドは `src/commands/*.js` に `export default { data, execute }` 形式で追加し、`src/deploy.js` で登録する
- Web server の各 route module は `bindRouteError` / `getSessionUser` / `callBot` などの共通ヘルパー（`src/web/server/routes/route-utils.js`）を経由する

## Dependencies

### External
- discord.js v14 / @discordjs/voice — Discord Bot・VC 接続
- yt-dlp（外部バイナリ、npm 依存ではない） / FFmpeg — 音声取得・トランスコード
- Google Gemini API — MIX の曲順補助・リクエスト文からのプレイリスト生成（Web process のみ）
- Fastify + better-sqlite3 — Web server と永続化
- React 19 + Vite + react-router-dom — Web ダッシュボード
- zod — QA manifest のスキーマ検証
- Playwright / vitest / node:test — テスト

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Cursor Cloud specific instructions

Standard commands live in `README.md` and `package.json` scripts. The notes below are non-obvious startup/run caveats for this environment (the update script already ran `npm install`, installed `yt-dlp`, and installed the Playwright Chromium browser).

### Env loading differs per process
- The **bot** process (`src/index.js`, `src/deploy.js`) loads `.env` itself via `dotenv/config`, so `npm start` / `node src/index.js` pick it up automatically.
- The **web** process (`src/web/server/index.js`) does **not** import dotenv (in Docker it relies on compose `env_file`). Run it locally with Node's flag: `node --env-file=.env src/web/server/index.js`.
- Create a local `.env` from `.env.example`. `MUSICBOT_TOKEN_ENC_KEY` must be a base64 32-byte key (`openssl rand -base64 32`); `WEB_SESSION_SECRET` / `BOT_API_TOKEN` any long random value.

### `build:web` does not produce `web/dist`
- `npm run build:web` is only a build-**validation** smoke test: it builds into a temp dir and deletes it (prints `P0_VITE_BUILD_OK`). It does **not** create `web/dist`.
- To actually populate `web/dist` so `music-web` can serve the SPA, run: `node node_modules/vite/bin/vite.js build --config web/vite.config.js --outDir dist`. The `music-web` server only registers static routes if `web/dist` exists at startup, so build it before (or restart after) generating it.
- For iterative UI dev, the Vite dev server on port 5173 is what the Playwright e2e config launches.

### Running the stack without real Discord credentials
- The full bot requires a real `DISCORD_TOKEN` secret. Without it, `node src/index.js` loads all settings/commands then exits with `TokenInvalid` at Discord login — expected.
- The bot's loopback API (`127.0.0.1:${BOT_API_PORT}`) only starts after the Discord client is `ready`. So when the bot isn't connected, the dashboard's live-state routes (which proxy to that API) return no live data, but auth/session/import/DB routes still work.
- To reach the dashboard without Discord OAuth, set `DEMO_LOGIN_ENABLED=true` + `DEMO_LOGIN_PASSWORD` in `.env` and POST the password to `/auth/demo/login` (the `/login/demo` page does this). This issues a `google-review-demo` session and lands on `/dashboard`.
- `yt-dlp` (used by `src/search.js` via bare `spawn('yt-dlp', ...)`) must be on `PATH`; the update script symlinks it into `/usr/local/bin`.

### Test suite notes
- `npm run test:server` takes several minutes (some tests spawn `yt-dlp` / do real work) — it is not hung.
- `npm run test:e2e`: the `landing route is public` spec currently fails on a stale copy assertion (the landing `<h1>` reads `Play-bot は Discord VC 用の音楽 Bot です。` while the test expects a heading matching `/Discord の音楽 Bot/`). This is a pre-existing test/code mismatch unrelated to environment setup; the other 5 browser specs pass.
