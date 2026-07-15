<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# browser

## Purpose

Playwright によるブラウザ E2E テスト。`npm run test:e2e`（`scripts/run-browser-tests.mjs`）から実行される。テスト実行時は Vite dev server（port 5173）が `webServer` として自動起動する。

## Key Files

| File | Description |
|------|--------------|
| `playwright.config.mjs` | `testMatch: '*.spec.js'`, `fullyParallel: false`, `workers: 1`（VC/DB 等の共有状態を避けるため直列実行）。`webServer.command` が `cd ../.. && node node_modules/vite/bin/vite.js ...` で Vite dev server を起動する |
| `p0-smoke.spec.js` | Chromium harness 自体が正しく起動・アサート・終了できるかを確認する P0 smoke test |
| `dashboard.spec.js` | ダッシュボード UI の E2E テスト。`statePayload` 等のフィクスチャで API レスポンスをモックし、Now playing/queue 表示を検証する |

## For AI Agents

### Working In This Directory
- 新しい spec ファイルは `*.spec.js` 命名にする（`testMatch` が拾う条件）
- `workers: 1` / `fullyParallel: false` は意図的な制約。テスト間で共有ポートやモック状態が衝突するのを防ぐため、並列化を勝手に有効にしない
- API モックは実際の `web/src/api/client.js` が呼ぶエンドポイント形状に合わせる（`dashboard.spec.js` の `statePayload` を参考にする）

### Testing Requirements
```bash
npm run test:e2e
```

<!-- MANUAL: -->
