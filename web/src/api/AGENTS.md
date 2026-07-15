<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# api

## Purpose

`music-web` の `/api/*` を呼ぶ唯一の fetch クライアント。JSDoc `@typedef` で `Track`/`PlaybackState`/`User`/`ServiceLink`/`Playlist`/`ImportJob`/`ImportTrack` の型を定義し、コンポーネント側の JSDoc 注釈から参照される。

## Key Files

| File | Description |
|------|--------------|
| `client.js` | `ApiError` クラスと `api` オブジェクト（state/control/queue/links/import 系の各エンドポイント呼び出し）。cookie session を前提に `credentials` 付きでリクエストする |

## For AI Agents

### Working In This Directory
- 新しい `/api/*` エンドポイントを backend（`src/web/server/routes/`）に追加したら、対応する関数をここに追加する。コンポーネントから直接 `fetch` を書かない
- レスポンス型を変更する場合は、対応する `@typedef` も更新する。`components/` 側の JSDoc がこの型を参照しているため

## Dependencies

### Internal
- backend の `src/web/server/routes/*.js` が定義する `/api/*` 契約に対応する

<!-- MANUAL: -->
