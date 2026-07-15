<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# services

## Purpose

Spotify Web API / YouTube Data API v3 に対する薄いクライアント。両ファイルは対称的な構造（`{service}Fetch` → `collectPages` → `list{Service}Playlists`/`list{Service}PlaylistTracks`）を持つ。

## Key Files

| File | Description |
|------|--------------|
| `spotify.js` | `listSpotifyPlaylists`, `listSpotifyPlaylistTracks`。**UI からは disabled**（Spotify の 2026年2月仕様変更で Development Mode の認可ユーザー上限が 5 人に縮小されたため）だが backend はそのまま維持されている。詳細はルート `CLAUDE.md` の「Spotify が disabled な理由」参照 |
| `youtube.js` | `listYoutubePlaylists`, `listYoutubePlaylistTracks`。scope は `youtube.readonly` のみ（読み取り専用、書き込み系スコープは要求しない） |

## For AI Agents

### Working In This Directory
- 両ファイルとも `getValidAccessToken(userId, service)`（`../../../db/tokenStore.js`）でトークンを取得してから API を呼ぶ。生のトークンをキャッシュ・ログ出力しない
- ページネーションは `collectPages` パターンに揃える。API 呼び出しごとに新規実装しない
- Spotify を UI で再有効化する場合、このファイルの変更は不要（`web/src/components/PlaylistPanel.jsx` の `SERVICES`/`DISABLED_SERVICES` を戻すだけで復活する設計）

## Dependencies

### Internal
- `../../../db/tokenStore.js`（`getValidAccessToken`）

<!-- MANUAL: -->
