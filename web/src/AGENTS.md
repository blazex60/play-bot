<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# src

## Purpose

React SPA 本体。single-screen ダッシュボード構成で、`App.jsx` がルーティング（`/`, `/login`, `/callback/*`）を持ち、`pages/Dashboard.jsx` が状態管理のハブとして `api/client.js` を通じて `music-web` の `/api/*` を呼び出す。

## Key Files

| File | Description |
|------|--------------|
| `main.jsx` | エントリーポイント。`#root` に `App` を `StrictMode` でマウント |
| `App.jsx` | `react-router-dom` のルーティング。`/` → `Dashboard`、`/login` → Discord OAuth 誘導、`/callback/*` → OAuth callback 完了画面（ブラウザ側フォールバック用） |
| `styles.css` | アプリ全体のスタイル |
| `p0-smoke.jsx` | CI/QA の P0 harness が生存確認に使うだけの最小コンポーネント。実プロダクト機能ではない |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | Web server API を呼ぶ fetch クライアント（see `api/AGENTS.md`） |
| `components/` | Dashboard を構成する個々の UI パーツ（see `components/AGENTS.md`） |
| `pages/` | ルーティング先ページ。現状 `Dashboard.jsx` のみ（see `pages/AGENTS.md`） |

## For AI Agents

### Working In This Directory
- ダッシュボードは single-screen 構成が仕様。Now playing、transport controls、queue reorder/remove、YouTube playlist browser、import panel、post-import match review を1画面に収める（ルート `CLAUDE.md` の「Web UI scope」参照）
- Spotify と Apple Music は disabled の「準備中」表示のみで、機能リンクは作らない（`components/PlaylistPanel.jsx` 参照）
- 型は TypeScript ではなく JSDoc コメントで注釈する（`web/tsconfig.json` の `checkJs` が検証）

### Testing Requirements
- `p0-smoke.test.jsx` が vitest + @testing-library/react での基本的なレンダリング確認の雛形
- `npm run test:web` で実行

### Common Patterns
- API 呼び出しは必ず `api/client.js` の `api` オブジェクト経由（コンポーネントから直接 `fetch` しない）
- props の型は JSDoc の `@param {{ ... }} props` で注釈する

## Dependencies

### External
- react-router-dom 7

<!-- MANUAL: -->
