<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# services

## Purpose

YouTube Data API v3 に対する薄いクライアント（`{service}Fetch` → `collectPages` → `list{Service}Playlists`/`list{Service}PlaylistTracks`）。

## Key Files

| File | Description |
|------|--------------|
| `youtube.js` | `listYoutubePlaylists`, `listYoutubePlaylistTracks`。scope は `youtube.readonly` のみ（読み取り専用、書き込み系スコープは要求しない） |

## For AI Agents

### Working In This Directory
- `getValidAccessToken(userId, service)`（`../../../db/tokenStore.js`）でトークンを取得してから API を呼ぶ。生のトークンをキャッシュ・ログ出力しない
- ページネーションは `collectPages` パターンに揃える。API 呼び出しごとに新規実装しない

## Dependencies

### Internal
- `../../../db/tokenStore.js`（`getValidAccessToken`）

<!-- MANUAL: -->
