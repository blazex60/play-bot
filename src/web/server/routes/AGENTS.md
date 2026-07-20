<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# routes

## Purpose

`/api/*` の認証必須ダッシュボード API。全 route は Bot process への操作を `botClient`（`../botClient.js`）経由のみで行い、DB アクセスは import/link 関連の route が直接 SQLite に対して行う。

## Key Files

| File | Description |
|------|--------------|
| `route-utils.js` | 共通ヘルパー: `getSessionUser(request)`（未認証なら 401 throw）, `callBot(botClient, method, path, body)`, `requireBotPermission`, `bindRouteError(reply, error)` |
| `state.js` | `GET /api/state/:guildId`（再生状態取得）, `GET /api/permission`（VC 同席/Admin 権限判定） |
| `control.js` | `POST /api/guilds/:guildId/control/:action`（`pause`/`resume`/`skip`/`stop`） |
| `queue.js` | `POST /api/guilds/:guildId/queue/:action`（`remove`/`move`） |
| `links.js` | `GET /api/links` 相当 — Spotify/YouTube の連携状態一覧（`service_links` テーブル参照） |
| `import.js` | プレイリスト import ジョブの開始。`services/` でプレイリストを取得し `matching.js` で YouTube にマッチングして `import_jobs`/`import_tracks` に書き込む |
| `import-edit.js` | import 後の手動マッチ修正（`match review`）。`matched_url`/`matched_title`/`match_status` を更新 |

## For AI Agents

### Working In This Directory
- 新しい route module を追加したら `../index.js` に登録する
- ハンドラは必ず `try { ... } catch (error) { return bindRouteError(reply, error) }` の形にする。手動で status code を分岐させない
- Bot への操作（再生制御・キュー操作）が必要な route は `requireBotPermission({ botClient, guildId, userId })` で VC 同席/Admin を確認してから `callBot` する。この順序を省略しない
- `CONTROL_ACTIONS` / `QUEUE_ACTIONS` のような許可アクションの `Set` は、未知の action に 404 を返すためのホワイトリスト。新アクション追加時は両方（route 側 + Bot API 側）を更新する

### Testing Requirements
- `import.test.js` 等はここには置かれておらず、`../index.test.js` が Fastify inject 経由で route を横断的にテストする

## Dependencies

### Internal
- `../botClient.js`, `../matching.js`, `../services/`, `../../../db/`（`links.js`/`import.js`/`import-edit.js`）

<!-- MANUAL: -->
