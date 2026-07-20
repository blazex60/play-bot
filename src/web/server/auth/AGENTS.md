<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# auth

## Purpose

Discord / YouTube の OAuth 2.0 authorize + callback route と、それらが共有する state/PKCE/token ヘルパー。

## Key Files

| File | Description |
|------|--------------|
| `oauth.js` | 共通ヘルパー: `randomToken`, PKCE (`createCodeVerifier`/`createCodeChallenge`), `insertOauthState`/`consumeOauthState`, `fetchJson`, `basicAuthHeader`, `tokenExpiresAt` |
| `discord.js` | `registerDiscordAuthRoutes` — ログイン用 OAuth（`identify` scope）。成功後に `web_sessions` cookie を発行する。`redirectAfterFromRequest` でオープンリダイレクトを防止 |
| `youtube.js` | `registerYoutubeAuthRoutes` — `youtube.readonly` scope の OAuth。Google の Testing 公開ステータスのため 100 ユーザー上限・7日で認可失効の制約がある（詳細はルート `CLAUDE.md`） |

## For AI Agents

### Working In This Directory
- state は必ず `insertOauthState` で発行し `consumeOauthState` で一度だけ検証・削除する（CSRF/リプレイ対策）。state を検証せずに callback を処理しない
- redirect 先パラメータを扱うコードを追加する場合は `discord.js` の `redirectAfterFromRequest` と同じ形（`/` 始まり、`//` と `/\` を拒否）のホワイトリスト検証を踏襲する
- token 保存は `defaultStoreTokens` が動的 import する `../../../db/tokenStore.js#upsertServiceLink` を経由する。生の access/refresh token をログに出さない
- OAuth client credential は `config.js` 経由でのみ参照する

### Testing Requirements
- `discord.test.js`, `youtube.test.js` がある。`fetchImpl` を差し替え可能にして外部 HTTP 呼び出しをモックする設計に揃える

## Dependencies

### Internal
- `../config.js`（各 provider の client id/secret/URL）
- `../../../db/tokenStore.js`（token 永続化、動的 import）

<!-- MANUAL: -->
