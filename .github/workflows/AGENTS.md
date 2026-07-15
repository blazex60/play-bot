<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# workflows

## Purpose

GitHub Actions のワークフロー定義。

## Key Files

| File | Description |
|------|--------------|
| `deploy.yml` | `main` への push（または手動 `workflow_dispatch`）で本番ホストに SSH デプロイする。Tailscale（`tag:ci`）で接続後、`appleboy/ssh-action` で `scripts/deploy.sh` を実行。このスクリプトは `git diff --name-only` で push 前後の変更ファイルを検査し、影響を受けたコンポーネント（`music-bot`、`music-web` または両方）のみをビルド・再起動する（ライブ Discord VC 接続とキューの状態損失を回避） |

## For AI Agents

### Working In This Directory
- このワークフローは `music-bot`（Docker Compose 3 service）のデプロイ専用。`legal/`（Cloudflare Pages）はこのワークフローの対象外で、Cloudflare 側の Git integration が別途自動デプロイする
- `scripts/deploy.sh` は変更ファイル一覧を検査して選択的にビルド・再起動する：`web/**`・`src/web/server/**` 変更 → `music-web` のみ再起動、その他の `src/**` 変更 → `music-bot` のみ再起動、`Dockerfile`・`docker-compose.yml`・`package*.json` 変更 → 両方、ドキュメント・`legal/` のみの変更 → no-op
- 必要な secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`（GitHub repository secrets）
- デプロイ先ホストの `~/music-bot/.env` は Actions の外で管理される前提（このワークフローは `.env` を触らない）

<!-- MANUAL: -->
