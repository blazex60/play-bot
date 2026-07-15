<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# test

## Purpose

コンテナディレクトリ。ユニットテスト（`*.test.js`）は各ソースファイルと同じ場所に置く方針のため、ここには単体テストでは収まらないブラウザ E2E テストと、`scripts/qa-task.mjs` の QA ランナー自体のテストのみが置かれる。

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `browser/` | Playwright によるブラウザ E2E テスト（see `browser/AGENTS.md`） |
| `qa/` | `scripts/qa-*.mjs`（manifest 駆動 QA ランナー）自体のテストと、実行対象の manifest 群（see `qa/AGENTS.md`） |

<!-- MANUAL: -->
