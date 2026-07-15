<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# workflows

## Purpose

GitHub Actions のワークフロー定義。

## Key Files

| File | Description |
|------|--------------|
| `deploy.yml` | `main` への push（または手動 `workflow_dispatch`）で本番ホストに SSH デプロイする。Tailscale（`tag:ci`）で接続後、`appleboy/ssh-action` で `cd ~/music-bot && git pull origin main && docker compose up --build -d` を実行 |

## For AI Agents

### Working In This Directory
- このワークフローは `music-bot`（Docker Compose 3 service）のデプロイ専用。`legal/`（Cloudflare Pages）はこのワークフローの対象外で、Cloudflare 側の Git integration が別途自動デプロイする
- 必要な secrets: `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`（GitHub repository secrets）
- デプロイ先ホストの `~/music-bot/.env` は Actions の外で管理される前提（このワークフローは `.env` を触らない）

<!-- MANUAL: -->
