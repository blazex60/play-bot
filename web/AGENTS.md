<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# web

## Purpose

React + Vite 製の Web ダッシュボード SPA。`bun run build:web`（`scripts/build-web.mjs`）が `web/vite.config.js` を使ってビルドし、成果物は `web/dist` に出力されて `music-web` process（`src/web/server/index.js`）が `@fastify/static` で配信する。開発時は Playwright テストが Vite dev server（port 5173）を起動する。`src/web/`（Bot 側の Web server ソース）とは別ディレクトリなので混同しないこと。

## Key Files

| File | Description |
|------|--------------|
| `index.html` | Vite のエントリー HTML（`#root` に `main.jsx` をマウント） |
| `vite.config.js` | Vite ビルド設定 |
| `bun-test-setup.js` | `bun run test:web` 用の happy-dom + Testing Library cleanup preload |
| `tsconfig.json` | `bun run typecheck`（`tsc --noEmit`）が使う JSDoc 型チェック設定。プロジェクトは TypeScript を書かず JSDoc + `.jsx` で型注釈する |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | SPA 本体（App、pages、components、API client）（see `src/AGENTS.md`） |

## For AI Agents

### Working In This Directory
- TypeScript ファイル（`.ts`/`.tsx`）は使わない。型は JSDoc コメント + `tsconfig.json` の `checkJs` で検証する
- `bun run build:web` はプロジェクトルートから実行する前提（`scripts/build-web.mjs` が `cwd` を解決する）

### Testing Requirements
```bash
bun run test:web     # bun:test + happy-dom（web/src）
bun run typecheck     # tsc --noEmit -p web/tsconfig.json
```

## Dependencies

### External
- React 19, react-router-dom 7, Vite 6
- bun:test + happy-dom + @testing-library/react（テスト）

<!-- MANUAL: -->
