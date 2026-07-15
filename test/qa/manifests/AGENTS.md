<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# manifests

## Purpose

`../../../scripts/qa-manifest.mjs` の zod スキーマ（`../../../scripts/qa-manifest.schema.json` にも対応する JSON Schema）に従う QA タスク定義。各ケースは resources（port/database/browserProfile/composeProject の割り当て）、steps（実行コマンド + timeout + assertions）、cleanup（実行後に存在してはいけないパス）を持つ。

## Key Files

| File | Description |
|------|--------------|
| `task-P0.json` | 正常系の唯一の manifest。`sqlite-load`（better-sqlite3 動作確認）、`server-smoke`（Fastify+zod）、`dom-smoke` 等のステップで基盤ツールチェーンの生存確認を行う |
| `invalid-collision.json` | resources の port/database 等が他ケースと衝突するケース。拒否されることを期待 |
| `invalid-directory-argv.json` | コマンド引数にディレクトリを渡す不正ケース |
| `invalid-fake-success.json` | assertion を満たさないのに成功したように見せかける不正ケース |
| `invalid-hung-browser.json` | ブラウザプロセスが終了しないケース（`terminateProcess` の防御確認用） |
| `invalid-leaked-resource.json` | cleanup 後にファイル/リソースが残留する不正ケース |
| `invalid-malformed.json` | JSON Schema 自体に違反する manifest |
| `invalid-missing-assertion.json` | assertion が定義されていない不正ケース |
| `invalid-path-escape.json` | `resolve`/`relative` によるパス脱出（`../` 等）を試みる不正ケース |

## For AI Agents

### Working In This Directory
- `invalid-*.json` は意図的に不正な manifest。**修正して「正常に通る」ようにしない** — これらは `../invalid-fixtures.test.mjs` がランナー側の拒否ロジックをテストするための fixture
- 新しい正常系 manifest を追加する場合は `qa-manifest.schema.json` に準拠させ、`task` フィールドは `^(P0|[1-9]|1[0-7]|F[1-4])$` パターンに従う
- port/database 名等の resources はケース間で衝突しない値にする（`invalid-collision.json` が検証する制約そのもの）

<!-- MANUAL: -->
