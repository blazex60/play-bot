<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# pages

## Purpose

ルーティング先のトップレベルページ。`Dashboard.jsx` がメインの状態管理ハブ、`Admin.jsx` が guild 管理者向け画面、`Help.jsx`/`Landing.jsx` は認証不要の公開ページ。

## Key Files

| File | Description |
|------|--------------|
| `Dashboard.jsx` | `guildId`（URL query または localStorage から取得、`../hooks/useGuildId.js`）を軸に、再生状態・権限・連携状態・キュー・import ジョブ・保存済みプレイリスト（`../hooks/useSavedPlaylists.js`）を `api/client.js` 経由でポーリング/取得し、`components/` 各パーツに props として配る。single-screen ダッシュボードの構成ルート |
| `Admin.jsx` | コマンド許可/拒否マトリクス・表示設定（public/personal）・操作ログ一覧。`extended`（guild admin）権限を持つユーザーのみアクセス可 |
| `Help.jsx` | `/help` — スラッシュコマンドの詳細な使い方一覧。認証不要の公開ページ |
| `Landing.jsx` | `/` — 未ログインでも見られるマーケティング/概要ページ。Discord ログインへの導線を持つ |

## For AI Agents

### Working In This Directory
- 状態フェッチ・更新ロジックはここ（またはページから使う `../hooks/*`）に集約し、`components/` 側には持ち込まない（components は表示 + コールバック呼び出しのみ）
- `guildId` の解決順は URL query (`?guildId=`) → `localStorage`。新しい永続化元を増やす場合はこの優先順位を崩さない（`../hooks/useGuildId.js` が一元管理する）
- busy/message 状態と成功/失敗ハンドリングは `../hooks/usePageActions.js` を共有する（`Dashboard.jsx`/`Admin.jsx` 双方が使う）

## Dependencies

### Internal
- `../api/client.js`（`api`, `ApiError`）
- `../hooks/*`（`useGuildId`, `useApiError`, `usePageActions`, `useSavedPlaylists`）
- `../components/*`（`AutoplayPanel`, `MatchReview`, `NowPlaying`, `OperationLogTable`, `PermissionMatrix`, `PlaylistBuilder`, `PlaylistPanel`, `QueueList`, `TransportControls`, `VisibilityPanel`）

<!-- MANUAL: -->
