<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-10-07 -->

# src

## Purpose

Bot 本体のソース。レイヤー分離された構成: `discord/`（Discord adapter: コマンド・interaction・エントリーポイント・loopback internal API）、`playback/`（再生ドメイン: PlaybackService・SessionManager・GuildPlayer・GuildQueue・autoplay ポリシー）、`media/`（yt-dlp 連携・MIX 曲順ロジック）、`audio/`（PCM/解析/トランジション/ステム等の音声基盤）、`shared/`（format/settings/webClient）、`local/`（ローカル CLI adapter）、`web/`（Fastify Web server と Web 専用 DB 層 `web/db/`）。Bot process と Web process は同じ `src/` ツリーから起動されるが、実行時プロセスとしては完全に分離している（`docker-compose.yml` 参照）。

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `discord/` | Discord adapter。`main.js`（bot エントリーポイント）、`deploy.js`、`commands/`、interaction ハンドラ（`queueEditorInteractions.js`/`recommendFlow.js`/`queueEditorView.js`/`views.js`）、`permissions.js`/`webPermission.js`、loopback internal API `botApi.js` |
| `playback/` | 再生ドメイン。`playbackService.js`（adapters 用の in-process facade）、`sessions.js`（SessionManager: VC セッション共有状態）、`sessionAccessors.js`（session フィールドの read-only ヘルパー）、`player.js`（GuildPlayer）、`queue.js`（GuildQueue）、`queueExhaustion.js`、`autoplay.js`（個人化/おすすめ選出）、`player/`（player 補助: `analysisCoordinator.js`・`playbackWatchdog.js`・`sourcePreparer.js`・`transitionCoordinator.js`・`mixerPipeline.js`・`queueAdvancement.js`・`playbackDrive.js`・`playbackPolicy.js`・`test-helpers.js`） |
| `media/` | メディア取得。`search.js`（yt-dlp spawn: 検索/メタデータ/ストリーム解決）、`mix/`（Camelot/ordering/playlistGenerate） |
| `audio/` | 音声基盤。`normalize.js`（loudnorm プリフェッチ）、`mixStream.js`、`pcmSource.js`、解析（`trackAnalysis`/`beatmixTransition`/`phraseAnalysis`/`downbeatAnalysis`/`keyAnalysis`/`vocalActivity`）、ステム（`stemCache`/`stemTransition`/`stemPrefetch`）、`tempo.js`、`analysisQueue.js` |
| `shared/` | adapter/domain 共有の純粋ユーティリティ。`format.js`（`fmtDuration`,`LOOP_LABELS`）、`settings.js`（guild 設定 JSON）、`webClient.js`（bot→web internal HTTP client） |
| `local/` | ローカル CLI adapter（`bun run player`、LocalVoiceConnection + sinks） |
| `web/` | `server/`（music-web process）と `db/`（better-sqlite3、Web process 専用） |

## For AI Agents

### Working In This Directory
- **依存方向**: adapters（`discord/`・`local/`）→ `playback/playbackService.js` → playback 内部（`sessions`/`GuildPlayer`/`GuildQueue`）→ `audio/`/`media/` インフラ。逆向きの import（例: `audio/` → `discord/`、`queue.js` → Discord 系、`media/` → player 状態）は禁止
- **循環インポート防止**: `playback/sessions.js` が VC セッションの共有状態を保持するハブ。`playback/queueExhaustion.js` のように `sessions.js` から呼ばれる側のモジュールは `sessions.js` を import せず、必要な値は関数引数（`getSession` サンク等）で受け取ること
- adapters は `session.player` / `session.queue` を直接操作しない。`sessions.js` の `playbackFor(sessions)` で取得する `PlaybackService`（`enqueue`/`pause`/`resume`/`skip`/`stop`/`seekTo`/`shuffle`/`cycleLoop`/`removeUpcoming`/`moveUpcoming`/`reorderUpcomingIfUnchanged`/`getState`）経由で操作する。セッション破棄は `destroySession(sessions, guildId)`
- adapters は `session.player`/`session.queue` 以外の session フィールド（`connection`/`planToken` 等）の読み取りにも `playback/sessionAccessors.js` の read-only ヘルパー（`sessionVoiceChannelId`/`sessionVoiceGuildId`/`sessionConnectionStatus`/`sessionPlanToken`/`isSessionStale`）を使う。`sessions.js` を import できない adapter（recommendFlow・permissions は循環になる）のため実体は leaf モジュールにあり、`sessions.js` から re-export される
- Bot process は `better-sqlite3` を絶対に import しない。DB（`src/web/db/`）が必要な操作は `src/web/server/` 経由の internal API を使う
- `playback/player.js` のウォッチドッグ（`playback/player/playbackWatchdog.js`）は `state.playbackDuration` の増加を見て判定する。`stateChange` イベント自体はループ再生開始時にしか発火しないため使わない。ストール時は `MixStream.dropCurrent()` する
- `#hadError` フラグは `queue.next({ forceAdvance: true })` を呼ぶ**前**に退避してからリセットする（順序が逆だと無限リトライになる）
- 音声は yt-dlp stdout を `PcmSource` 経由で s16le 化し、セッション寿命の `MixStream` に載せる。`StreamType.Arbitrary` で曲ごとに `createAudioResource` する旧経路は使わない（詳細はルート `CLAUDE.md`）

### Testing Requirements
- 各モジュールに対応する `*.test.js` が同じディレクトリにある（`node:test` + `node:assert/strict`）
- `bun run test:server` で `scripts/run-node-tests.mjs` 経由で実行される

### Common Patterns
- スラッシュコマンドは `execute(interaction, sessions)` シグネチャで統一
- ユーザー向け返信は絵文字プレフィックス付きの日本語メッセージ（`❌`, `✅`, `⏸️` 等）
- VC 操作系コマンドは必ず `requireSessionInSameVoice(interaction, sessions, {...})` でセッション取得+VC 同席チェックをまとめて行う

## Dependencies

### Internal
- `discord/commands/` は `playback/`（`playbackFor` 経由の操作）、`discord/permissions.js`、`discord/queueEditorView.js`、`media/search.js` に依存
- `web/server/` は `web/db/` と `media/search.js` / `playback/queue.js`（YouTube マッチング用）に依存
- `playback/` は `audio/`（MixStream/PcmSource/解析/ステム）と `media/search.js` に依存

### External
- discord.js v14, @discordjs/voice ^0.19.2 以上
- yt-dlp（child_process 経由の外部バイナリ）, FFmpeg

<!-- MANUAL: -->
