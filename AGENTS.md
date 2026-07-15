<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# music-bot

## Purpose

Discord VC で YouTube 音楽をストリーミング再生する Bot。discord.js v14 + @discordjs/voice + yt-dlp + FFmpeg で音声を処理し、Fastify + React の Web ダッシュボードから再生操作と Spotify/YouTube プレイリスト取り込みを行える。LLM・外部 AI API は一切使用しない。`legal/` は同じリポジトリで管理する Cloudflare Pages 向けの独立した静的法務ページ（利用規約・プライバシーポリシー）。

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
- Bot process（`src/index.js` 系）は SQLite を一切開かない。DB は Web process（`src/web/server/`）専用。この境界を壊さないこと
- Bot API（`src/botApi.js`）は loopback (`127.0.0.1:${BOT_API_PORT}`) 限定で bearer token 必須。Cloudflare Tunnel には絶対に出さない
- シークレットは全て `.env` のみ。ソースコードに書かない
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
- Fastify + better-sqlite3 — Web server と永続化
- React 19 + Vite + react-router-dom — Web ダッシュボード
- zod — QA manifest のスキーマ検証
- Playwright / vitest / node:test — テスト

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
