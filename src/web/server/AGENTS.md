<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# server

## Purpose

`music-web` process 本体。Fastify server の起動、Discord/YouTube OAuth、cookie ベースの session、暗号化トークンストア、プレイリスト import パイプラインを SQLite に書き込む。ビルド済み React dashboard（`web/dist`）を static ファイルとして配信する。`music-bot` process とは完全に別プロセスとして起動され（`docker-compose.yml`）、両者は `botClient.js`（loopback HTTP + bearer token）でのみ通信する。

## Key Files

| File | Description |
|------|--------------|
| `index.js` | エントリーポイント（`node src/web/server/index.js`）。Fastify 初期化、cookie/static plugin 登録、`runMigrations`、各 route 群と OAuth route の登録、cleanup job の起動 |
| `config.js` | 全環境変数を1箇所に集約する `createWebConfig(env)`。`PUBLIC_BASE_URL` から OAuth redirect URI を導出（Discord のみ `DISCORD_OAUTH_REDIRECT` で override 可） |
| `botClient.js` | Bot process の internal API（`src/botApi.js`）を呼ぶ HTTP クライアント。`BotApiError` を投げる |
| `matching.js` | YouTube のプレイリストトラックを YouTube 検索結果とマッチングするロジック（`resolveImportTracks` 等） |
| `cleanup.js` | 期限切れ `oauth_states` / `web_sessions` を定期削除するジョブ（`startCleanupJob`, 既定 10 分間隔） |
| `testSupport.js` | テスト用インメモリ SQLite（`createMemoryDb`）とスキーマ定義 |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `auth/` | Discord/YouTube OAuth（authorize/callback）route と PKCE/state ヘルパー（see `auth/AGENTS.md`） |
| `middleware/` | `requireAuth` — cookie session を検証する Fastify middleware（see `middleware/AGENTS.md`） |
| `routes/` | `/api/*` の認証必須ダッシュボード API route 群（see `routes/AGENTS.md`） |
| `services/` | YouTube Data API の薄いクライアント（see `services/AGENTS.md`） |

## For AI Agents

### Working In This Directory
- ここは唯一 `better-sqlite3` を開くプロセス。Bot process とのやり取りは常に `botClient.js` 経由（直接 `sessions` Map 等を import しない）
- Bot API URL/token は `config.js` の `botApi.url` / `botApi.token` から取得する。Cloudflare Tunnel は `WEB_PORT` のみを通すため、Bot API への到達性は loopback 前提で書くこと
- `/api/*` のオープンリダイレクト等の脆弱性クラスは既に一度修正されている（`auth/discord.js` の `redirectAfterFromRequest` 参照）。新しい redirect パラメータを扱う際は同様のホワイトリスト検証を行う
- OAuth redirect URI は `config.js` の `buildUrl(publicBaseUrl, path)` で一元的に導出する。ハードコードしない

### Testing Requirements
- 各モジュールに対応する `*.test.js` がある。`testSupport.js` の `createMemoryDb()` でインメモリ SQLite を使い、`process.env.MUSICBOT_TOKEN_ENC_KEY` をテスト用鍵に設定してから実行する
- `npm run test:server` で実行される

### Common Patterns
- route ハンドラは `try { ... } catch (error) { return bindRouteError(reply, error) }` の形に統一（`routes/route-utils.js`）
- 認証必須 route は `getSessionUser(request)` でユーザーを取得し、なければ 401 相当のエラーを投げる

## Dependencies

### Internal
- `../../db/`（`tokenStore.js`, `migrate.js`）
- `../../search.js`（YouTube マッチングに使用）
- `../../queue.js`（`createTrack`）

### External
- Fastify, @fastify/cookie, @fastify/static, better-sqlite3

<!-- MANUAL: -->
