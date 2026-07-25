<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# routes

## Purpose

`/api/*` の認証必須ダッシュボード API。全 route は Bot process への操作を `botClient`（`../botClient.js`）経由のみで行い、DB アクセスは import/link/playlists 関連の route が直接 SQLite に対して行う。

## Key Files

| File | Description |
|------|--------------|
| `route-utils.js` | 共通ヘルパー: `getSessionUser(request)`（未認証なら 401 throw）, `callBot(botClient, method, path, body)`, `requireBotPermission`/`requireAdminPermission`/`requireCommandPermission`, `enqueueImportTracks(botClient, guildId, payload)`, `bindRouteError(reply, error)`, `recordOperationLog(db, {...})`, `withAuditedBotAction(request, reply, { db, source, action, guard, run, buildDetail, isSuccess })`（permission チェック→実行→監査ログ→返信の定型処理をまとめるヘルパー） |
| `state.js` | `GET /api/state/:guildId`（再生状態取得）, `GET /api/permission`（VC 同席/Admin 権限判定） |
| `control.js` | `POST /api/guilds/:guildId/control/:action`（`pause`/`resume`/`skip`/`stop`/`autoplay`）。`withAuditedBotAction` で実装 |
| `queue.js` | `POST /api/guilds/:guildId/queue/:action`（`remove`/`move`）。`withAuditedBotAction` で実装 |
| `admin.js` | `/api/admin/:guildId/*` — コマンド許可/拒否マトリクス（`permissions`, `permissions/default`, `permissions/user`）、表示設定（`visibility`）、操作ログ（`logs`）。すべて `extended`（guild admin）権限が必要 |
| `links.js` | `GET /api/links` 相当 — YouTube の連携状態一覧（`service_links` テーブル参照） |
| `import.js` | プレイリスト import ジョブの開始。`services/` でプレイリストを取得し `matching.js` で YouTube にマッチングして `import_jobs`/`import_tracks` に書き込む |
| `import-edit.js` | import 後の手動マッチ修正（`match review`）。`matched_url`/`matched_title`/`match_status` を更新 |
| `playlists.js` | `/api/playlists/mine/*` — 「My Playlists」保存済みプレイリストの CRUD・曲検索・曲追加/削除/並べ替え・guild キューへの投入。SQL 層は `playlists-db.js` に分離 |
| `playlists-db.js` | `playlists.js` 用の SQL prepared statement 層（`user_playlists`/`user_playlist_tracks` の CRUD 関数）。HTTP には関与しない |
| `internal.js` | `/internal/*` — Bot process からの loopback 専用エンドポイント（play history 記録）。ブラウザ cookie session ではなく bearer token（`BOT_API_TOKEN`）で認証する点が他 route と異なる |

## For AI Agents

### Working In This Directory
- 新しい route module を追加したら `../index.js` に登録する
- ハンドラは必ず `try { ... } catch (error) { return bindRouteError(reply, error) }` の形にする。手動で status code を分岐させない。permission チェック→Bot 呼び出し→監査ログ→返信という定型パターンに当てはまる場合は `withAuditedBotAction` を使う（`control.js`/`queue.js`/`admin.js` の実装を参照）
- Bot への操作（再生制御・キュー操作）が必要な route は `requireBotPermission({ botClient, guildId, userId })` で VC 同席/Admin を確認してから `callBot`（または `botClient` の名前付きメソッド）する。この順序を省略しない
- `CONTROL_ACTIONS` / `QUEUE_ACTIONS` のような許可アクションの `Set` は、未知の action に 404 を返すためのホワイトリスト。新アクション追加時は両方（route 側 + Bot API 側）を更新する
- Bot へのプレイリスト/import 系トラック投入は必ず `enqueueImportTracks(botClient, guildId, payload)`（`route-utils.js`）を経由する。同じ処理をファイルごとに再実装しない

### Testing Requirements
- `admin.test.js`, `internal.test.js`, `playlists.test.js` はこのディレクトリに置かれている。それ以外（`control.js`/`queue.js`/`import.js`/`import-edit.js`/`links.js`/`state.js`）は `../index.test.js` が Fastify inject 経由で route を横断的にテストする

## Dependencies

### Internal
- `../botClient.js`, `../matching.js`, `../services/`, `../../../db/`（`links.js`/`import.js`/`import-edit.js`/`playlists-db.js`）
- `../../../queue.js`（`createTrack`）, `../../../search.js`（`searchYoutube`/`resolveMetadata`）

<!-- MANUAL: -->
