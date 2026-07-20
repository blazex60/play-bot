<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# components

## Purpose

`pages/Dashboard.jsx` が組み立てる single-screen ダッシュボードを構成する個々の表示・操作パーツ。すべて props 駆動の関数コンポーネントで、状態は持たず `Dashboard.jsx` から渡されたコールバックを呼ぶだけ。

## Key Files

| File | Description |
|------|--------------|
| `NowPlaying.jsx` | 現在再生中トラックの表示（`PlaybackState` を受け取る） |
| `TransportControls.jsx` | pause/resume/skip/stop ボタン |
| `QueueList.jsx` | キュー一覧。並び替え（`onMove`）・削除（`onRemove`）操作 |
| `PlaylistPanel.jsx` | YouTube プレイリスト選択・import 開始 UI。`SERVICES`（有効: YouTube のみ）と `DISABLED_SERVICES`（Spotify, Apple Music を「準備中」表示）を分離管理 |
| `MatchReview.jsx` | import 後の YouTube マッチング結果レビュー。検索クエリ変更・再検索・置換操作 |

## For AI Agents

### Working In This Directory
- **Spotify を UI で再有効化する場合**: `PlaylistPanel.jsx` の `SERVICES`/`DISABLED_SERVICES` 配列を書き換えるだけで良い設計。backend（OAuth route, DB schema, import pipeline）は既に維持されているため、このファイル以外の変更は原則不要（理由はルート `CLAUDE.md` 参照）
- 各コンポーネントは JSDoc `@param {{ ... }} props` で `web/src/api/client.js` の型を参照する。新しい prop を追加したら型注釈も更新する
- コンポーネント内で `fetch` を直接呼ばない。データ取得・更新は `pages/Dashboard.jsx` が `api/client.js` 経由で行い、結果を props で渡す

### Testing Requirements
- `PlaylistPanel.test.jsx` が既存のテスト例。vitest + @testing-library/react

<!-- MANUAL: -->
