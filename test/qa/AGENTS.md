<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# qa

## Purpose

`scripts/qa-manifest.mjs` / `scripts/qa-safety.mjs` / `scripts/qa-task.mjs`（manifest 駆動の QA タスクランナー）自体をテストする。CI/エージェントがタスク単位で「本当に動くか」を検証するための安全なサンドボックス実行基盤の正当性を保証する層。

## Key Files

| File | Description |
|------|--------------|
| `invalid-fixtures.test.mjs` | `manifests/invalid-*.json` の各不正 fixture が `parseManifest`/`validateManifestPaths`/`runQaCase` で正しく拒否されることを検証 |
| `qa-safety.test.mjs` | `createChildEnvironment`（環境変数ホワイトリスト化）、`redactOutput`、`terminateProcess`、`writeExclusiveFile` のユニットテスト |
| `qa-task.test.mjs` | `runQaCase` の実行フロー全体（コマンド実行 → assertion → cleanup 検証）のテスト |
| `server-smoke.test.mjs` | Fastify + zod の P0 harness が実際に応答することを確認するテンプレート的スモークテスト。`manifests/task-P0.json` の `server-smoke` ステップから呼ばれる |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `manifests/` | QA ランナーが実行する manifest（JSON）。正常系（`task-P0.json`）と、ランナーの防御機構を検証するための不正系（`invalid-*.json`）（see `manifests/AGENTS.md`） |

## For AI Agents

### Working In This Directory
- `invalid-*.json` 系のテストは「ランナーが危険な manifest を確実に拒否すること」を保証するためのもの。新しい防御機構（環境変数漏洩防止、symlink 拒否、path escape 防止等）を `scripts/qa-safety.mjs` に追加したら、対応する `invalid-*.json` fixture と `invalid-fixtures.test.mjs` のケースをここに追加する
- `server-smoke.test.mjs` は `scripts/run-node-tests.mjs` の探索対象からも、`manifests/task-P0.json` の実行対象としても使われる二重の役割を持つ。変更時は両方への影響を確認する

<!-- MANUAL: -->
