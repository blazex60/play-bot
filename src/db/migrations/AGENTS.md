<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# migrations

## Purpose

`../migrate.js` が起動時に順次適用する SQL マイグレーションファイル。適用履歴は `schema_migrations` テーブルに記録される。

## Key Files

| File | Description |
|------|--------------|
| `001_init.sql` | 初期スキーマ: `discord_users`, `web_sessions`, `service_links`（外部サービス連携トークン）, `oauth_states`, `import_jobs`, `import_tracks` |
| `002_play_history.sql` | `play_history`(ギルド/ユーザーごとの再生履歴。autoplay のパーソナライズ機能が参照する) |
| `003_user_playlists.sql` | `user_playlists`, `user_playlist_tracks`(ダッシュボードの「My Playlists」保存済みプレイリスト機能) |
| `004_operation_logs.sql` | `operation_logs`(ダッシュボード操作・Bot コマンドの監査ログ。`(guild_id, id DESC)` でインデックス) |
| `005_remove_spotify_service_check.sql` | `service_links.service` の CHECK 制約から過去の名残だった `spotify` を除去し `youtube` のみ許可するよう縮小。`001_init.sql` は変更禁止のため、テーブル再作成(`_new` 作成 → コピー → DROP → RENAME)方式で適用 |
| `006_track_analysis.sql` | `track_analysis`(MIX クロスフェード用の曲解析キャッシュ。BPM/キー/曲末形状/`payload_json`) |
| `007_vocal_activity.sql` | `track_analysis` に Demucs ボーカル区間検出の列を追加(`last_vocal_end_sec`, `vocal_gaps_json`, `analysis_source`) |
| `008_beatmix_analysis.sql` | `track_analysis` に Phase 7 beatmix 判定用の列を追加(`downbeat_confidence`, `phrase_confidence`, `meter`)。beat grid / downbeat / phrase の配列自体は `payload_json` のみに保持 |

## For AI Agents

### Working In This Directory
- 新しいマイグレーションは `002_*.sql` のように連番プレフィックスで追加する。既存ファイルは変更禁止（本番 DB に適用済みのため）
- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` のように冪等な DDL にする

### Testing Requirements
- `../tokenStore.test.js` が `runMigrations()` を通じて間接的に検証する。新規テーブルを追加した場合は対応するテストも追加する

<!-- MANUAL: -->
