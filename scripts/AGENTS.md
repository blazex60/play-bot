<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# scripts

## Purpose

ビルドとテスト実行を仲介する Node スクリプト群。npm scripts（`package.json`）から呼ばれる薄いラッパーと、QA タスクをサンドボックス化して実行する manifest ベースのランナー。

## Key Files

| File | Description |
|------|--------------|
| `build-web.mjs` | `web/vite.config.js` で Vite ビルドを実行し、一時ディレクトリ経由で成果物を配置する（`npm run build:web`） |
| `run-node-tests.mjs` | `src/`, `scripts/` 配下の `*.test.js` を再帰的に検出して `node --test` で実行する。`web/` ディレクトリは除外するが `src/web/` は除外**しない**よう明示的にコメントで注意書きされている（basename 一致で誤除外した過去のバグの再発防止） |
| `run-browser-tests.mjs` | Playwright を `test/browser/playwright.config.mjs` で実行する（`npm run test:e2e`） |
| `qa-manifest.mjs` | QA manifest（`test/qa/manifests/*.json`）を zod スキーマで検証・パースする。`assertionSchema`（`outputIncludes`/`pathExists`）や `resourceSchema`（port/database/browserProfile/composeProject の割り当て）を定義 |
| `qa-safety.mjs` | QA タスク実行時のサンドボックス化ヘルパー: 環境変数のホワイトリスト化（`createChildEnvironment`）、シンボリックリンク拒否、出力の秘匿情報redaction、排他的ファイル書き込み |
| `qa-task.mjs` | manifest 駆動で QA ケース（一連のコマンド + assertion + cleanup 検証）を実行するランナー（`npm run qa:task`） |
| `qa-manifest.schema.json` | `qa-manifest.mjs` の zod スキーマに対応する JSON Schema（外部ツール・エディタ補完用） |

## For AI Agents

### Working In This Directory
- `run-node-tests.mjs` の除外リストを変更する際は、basename の単純一致ではなく相対パスの各セグメントで判定するパターンを維持する（`src/web/` と `web/` の混同を防ぐため、上記コメント参照）
- QA 関連（`qa-*.mjs`）は意図的に外部プロセスへの環境変数漏洩を防ぐ設計。`createChildEnvironment` のホワイトリストを緩めない
- 各スクリプトは `fileURLToPath(new URL('..', import.meta.url))` でプロジェクトルートを解決する。`cwd` 依存のハードコードパスを増やさない

### Testing Requirements
- `run-node-tests.test.mjs` が `run-node-tests.mjs` のテスト探索ロジック自体をテストする（メタテスト）
- QA ランナー本体のテストは `test/qa/` にある

## Dependencies

### Internal
- `qa-task.mjs` は `qa-manifest.mjs` と `qa-safety.mjs` に依存し、`run-node-tests.mjs` の `assertSupportedNodeVersion` を再利用する

### External
- zod（manifest 検証）
- vite, @playwright/test（子プロセスとして起動）

<!-- MANUAL: -->
