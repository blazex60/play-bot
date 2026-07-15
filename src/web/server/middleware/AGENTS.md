<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# middleware

## Purpose

Fastify 用の認証 middleware。ファイルは 1 つのみ。

## Key Files

| File | Description |
|------|--------------|
| `requireAuth.js` | `createRequireAuth({ db, config })` — cookie の session id を `web_sessions` JOIN `discord_users` で検証し、`request.user` 相当の情報を注入する。無効/期限切れなら 401 |

## For AI Agents

### Working In This Directory
- 新しい認証必須 route を追加する場合は、この middleware を Fastify の `preHandler` として登録する既存パターンに揃える（`routes/AGENTS.md` の `getSessionUser` 経由の想定と一致させる）
- SQL は prepared statement（`db.prepare(...)`）を再利用する（毎リクエストで `prepare` し直さない）

<!-- MANUAL: -->
