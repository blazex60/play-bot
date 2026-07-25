<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# components

## Purpose

`pages/Dashboard.jsx`/`pages/Admin.jsx` が組み立てるダッシュボード・管理画面を構成する個々の表示・操作パーツ。すべて props 駆動の関数コンポーネントで、状態は持たず呼び出し元ページから渡されたコールバックを呼ぶだけ。

## Key Files

| File | Description |
|------|--------------|
| `NowPlaying.jsx` | 現在再生中トラックの表示（`PlaybackState` を受け取る） |
| `TransportControls.jsx` | pause/resume/skip/stop ボタン |
| `AutoplayPanel.jsx` | 自動再生モード（オフ/自動/おすすめ）とパーソナライズ設定の切り替え |
| `QueueList.jsx` | キュー一覧。並び替え（`onMove`）・削除（`onRemove`）操作 |
| `PlaylistPanel.jsx` | YouTube プレイリスト選択・import 開始 UI。`SERVICES`（YouTube のみ）を管理 |
| `MatchReview.jsx` | import 後の YouTube マッチング結果レビュー。検索クエリ変更・再検索・置換操作 |
| `PlaylistBuilder.jsx` | 「My Playlists」保存済みプレイリストの作成・改名・削除・曲追加/削除/並べ替え・guild キューへの投入。props は `{ state, actions }` の2つに集約されている（`../hooks/useSavedPlaylists.js` が生成） |
| `PermissionMatrix.jsx` | (`pages/Admin.jsx` 用) コマンドごとのデフォルト許可/拒否とユーザー別オーバーライドの編集 |
| `VisibilityPanel.jsx` | (`pages/Admin.jsx` 用) コマンド返信の公開設定（public/personal）編集 |
| `OperationLogTable.jsx` | (`pages/Admin.jsx` 用) 操作ログの一覧表示とページネーション（`onLoadMore`） |

## For AI Agents

### Working In This Directory
- 各コンポーネントは JSDoc `@param {{ ... }} props` で `web/src/api/client.js` の型を参照する。新しい prop を追加したら型注釈も更新する
- コンポーネント内で `fetch` を直接呼ばない。データ取得・更新は呼び出し元ページ（`pages/Dashboard.jsx`/`pages/Admin.jsx`）または `../hooks/*` が `api/client.js` 経由で行い、結果を props で渡す
- props が多くなりがちなコンポーネント（`PlaylistBuilder.jsx` 等）は個別 prop を並べるのではなく `{ state, actions }` のようにグループ化することを検討する

### Testing Requirements
- `PlaylistPanel.test.jsx`, `PlaylistBuilder.test.jsx`, `PermissionMatrix.test.jsx` が既存のテスト例。vitest + @testing-library/react

<!-- MANUAL: -->
