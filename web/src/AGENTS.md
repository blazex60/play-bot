<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# src

## Purpose

React SPA 本体。`App.jsx` がルーティング（`/`, `/dashboard`, `/admin`, `/help`, `/login`, `/login/demo`, `/callback/*`）を持ち、`pages/Dashboard.jsx` がメインダッシュボードの状態管理ハブとして `api/client.js` を通じて `music-web` の `/api/*` を呼び出す。`pages/Admin.jsx` は guild 管理者向けの別画面。

## Key Files

| File | Description |
|------|--------------|
| `main.jsx` | エントリーポイント。`#root` に `App` を `StrictMode` でマウント |
| `App.jsx` | `react-router-dom` のルーティング。`/` → `Landing`、`/dashboard` → `Dashboard`、`/admin` → `Admin`、`/help` → `Help`、`/login` → Discord OAuth 誘導、`/login/demo` → デモログイン（`DEMO_LOGIN_ENABLED` 時のみ有効）、`/callback/*` → OAuth callback 完了画面（ブラウザ側フォールバック用） |
| `styles.css` | アプリ全体の共通スタイル（ダークテーマのトークン定義を含む） |
| `dashboard.css` | ダッシュボード/管理画面専用スタイル |
| `landing.css` | ランディング/ヘルプページ専用スタイル |
| `p0-smoke.jsx` | CI/QA の P0 harness が生存確認に使うだけの最小コンポーネント。実プロダクト機能ではない |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | Web server API を呼ぶ fetch クライアント（see `api/AGENTS.md`） |
| `components/` | Dashboard/Admin を構成する個々の UI パーツ（see `components/AGENTS.md`） |
| `pages/` | ルーティング先ページ: `Dashboard`, `Admin`, `Help`, `Landing`（see `pages/AGENTS.md`） |
| `hooks/` | ページ間で共有する React hook（`useGuildId`, `useApiError`, `usePageActions`, `useSavedPlaylists`） |

## For AI Agents

### Working In This Directory
- ダッシュボード（`/dashboard`）は single-screen 構成が仕様。Now playing、transport controls、autoplay/personalize、queue reorder/remove、YouTube playlist browser、import panel、post-import match review、My Playlists を1画面に収める（ルート `CLAUDE.md` の「Web UI scope」参照）。管理系 UI（権限マトリクス・表示設定・操作ログ）は `/admin` に分離されている
- プレイリスト連携は YouTube のみ。Spotify/Apple Music はバックエンドごと削除済み（`components/PlaylistPanel.jsx` 参照）
- 型は TypeScript ではなく JSDoc コメントで注釈する（`web/tsconfig.json` の `checkJs` が検証）
- ページ間で重複しがちなロジック（`guildId` 解決、API エラー処理、busy/message 状態）は `hooks/` に切り出す

### Testing Requirements
- `p0-smoke.test.jsx` が bun:test + @testing-library/react での基本的なレンダリング確認の雛形
- `bun run test:web` で実行

### Common Patterns
- API 呼び出しは必ず `api/client.js` の `api` オブジェクト経由（コンポーネントから直接 `fetch` しない）
- props の型は JSDoc の `@param {{ ... }} props` で注釈する

## Dependencies

### External
- react-router-dom 7

<!-- MANUAL: -->
