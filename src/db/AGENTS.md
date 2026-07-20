<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# db

## Purpose

better-sqlite3 を使った永続化層。**Web process (`src/web/server/`) 専用** — Bot process (`src/index.js`) はこのディレクトリを import しない。Discord ユーザー、Web セッション、OAuth state、外部サービス連携トークン（暗号化済み）、プレイリスト import 履歴を管理する。

## Key Files

| File | Description |
|------|--------------|
| `index.js` | DB ハンドル取得（`getDatabase()`）。DB パスは `MUSICBOT_DB_PATH` 環境変数（既定: `data/musicbot.db`） |
| `migrate.js` | `migrations/*.sql` を `schema_migrations` テーブルで管理しながら順次適用する（`runMigrations(db)`） |
| `crypto.js` | AES-256-GCM によるトークン暗号化/復号（`encrypt`/`decrypt`）。鍵は `MUSICBOT_TOKEN_ENC_KEY`（32-byte base64）。鍵ローテーション用に `getKeyId()` あり |
| `tokenStore.js` | YouTube の OAuth token を暗号化して保存し、期限切れ間近なら自動リフレッシュする（`getValidAccessToken`, `upsertServiceLink`）。同時リフレッシュを `inflightRefreshes` で防止 |
| `inspect.js` | 各テーブルの行数を表示するデバッグ用 CLI（`npm run db:inspect`） |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `migrations/` | 順序付き SQL マイグレーションファイル（see `migrations/AGENTS.md`） |

## For AI Agents

### Working In This Directory
- スキーマを変更する場合は `migrations/` に新しい番号付き `.sql` ファイルを追加する。既存マイグレーションは編集しない（適用済み環境との整合性が壊れる）
- `MUSICBOT_TOKEN_ENC_KEY` を失うと保存済みトークンは復号不可能になる。鍵のデフォルト値やフォールバックは絶対に実装しない
- `crypto.js` の暗号化パラメータ（`aes-256-gcm`, IV 12 bytes, tag 16 bytes）は互換性のため変更しない

### Testing Requirements
- `crypto.test.js`, `tokenStore.test.js` が `node:test` で用意されている。`tokenStore.test.js` は `configureDatabasePathForTest` で一時 SQLite ファイルを使う

### Common Patterns
- 全クエリは `db.prepare(...).run()/.get()/.all()` の prepared statement
- テスト用に `configureDatabasePathForTest(path)` / `closeDatabase()` を各モジュールが公開している

## Dependencies

### External
- better-sqlite3

<!-- MANUAL: -->
