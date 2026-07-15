<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# pages

## Purpose

ルーティング先のトップレベルページ。現状 `Dashboard.jsx` のみで、ダッシュボードの状態管理ハブを兼ねる。

## Key Files

| File | Description |
|------|--------------|
| `Dashboard.jsx` | `guildId`（URL query または localStorage から取得）を軸に、再生状態・権限・連携状態・キュー・import ジョブを `api/client.js` 経由でポーリング/取得し、`components/` 各パーツに props として配る。single-screen ダッシュボードの構成ルート |

## For AI Agents

### Working In This Directory
- 状態フェッチ・更新ロジックはここに集約し、`components/` 側には持ち込まない（components は表示 + コールバック呼び出しのみ）
- `guildId` の解決順は URL query (`?guildId=`) → `localStorage`。新しい永続化元を増やす場合はこの優先順位を崩さない

## Dependencies

### Internal
- `../api/client.js`（`api`, `ApiError`）
- `../components/*`（`MatchReview`, `NowPlaying`, `PlaylistPanel`, `QueueList`, `TransportControls`）

<!-- MANUAL: -->
