<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# migrations

## Purpose

`../migrate.js` が起動時に順次適用する SQL マイグレーションファイル。適用履歴は `schema_migrations` テーブルに記録される。

## Key Files

| File | Description |
|------|--------------|
| `001_init.sql` | 初期スキーマ: `discord_users`, `web_sessions`, `service_links`（Spotify/YouTube 連携トークン）, `oauth_states`, `import_jobs`, `import_tracks` |

## For AI Agents

### Working In This Directory
- 新しいマイグレーションは `002_*.sql` のように連番プレフィックスで追加する。既存ファイルは変更禁止（本番 DB に適用済みのため）
- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` のように冪等な DDL にする

### Testing Requirements
- `../tokenStore.test.js` が `runMigrations()` を通じて間接的に検証する。新規テーブルを追加した場合は対応するテストも追加する

<!-- MANUAL: -->
