<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# src

## Purpose

Bot 本体のソース。Discord client のエントリーポイント、VC セッション管理、キュー/プレイヤー、yt-dlp 連携、スラッシュコマンド、そして Web process 専用の DB 層（`src/db/`）と Fastify Web server（`src/web/`）を含む。Bot process と Web process は同じ `src/` ツリーから起動されるが、実行時プロセスとしては完全に分離している（`docker-compose.yml` 参照）。

## Key Files

| File | Description |
|------|--------------|
| `index.js` | Discord Bot エントリーポイント。client 起動、コマンドロード、interaction イベント処理、`botApi.js` の起動 |
| `sessions.js` | Guild ごとの VC セッション共有状態（`Map<guildId, { connection, player, queue }>`）。`joinVoiceChannel` + `entersState(Ready)` |
| `player.js` | `GuildPlayer`。AudioPlayer のラップ、ストール検出ウォッチドッグ、`#hadError` フラグによるトラックスキップ制御 |
| `queue.js` | `GuildQueue`。トラック配列と `LoopMode`（OFF/TRACK/QUEUE）を管理 |
| `search.js` | yt-dlp を `child_process.spawn` で呼び出し、検索・メタデータ取得・ストリーム URL 解決を行う |
| `normalize.js` | FFmpeg loudnorm によるトラック単位の音量ノーマライズ（`/normalize` コマンド用） |
| `views.js` | 検索結果ボタン UI（`ActionRowBuilder`）と `SearchPendingStore` |
| `queueEditorView.js` / `queueEditorInteractions.js` | キュー編集用の Embed/コンポーネント生成と、そのボタン・モーダル interaction ハンドラ |
| `permissions.js` | スラッシュコマンド用の VC 同席チェック（`checkSameVoiceChannel`） |
| `webPermission.js` | Web ダッシュボードからの操作権限判定（`resolveWebPermission`）。VC 同席 or `ADMIN_ROLE_ID` |
| `settings.js` | Guild 単位の設定（normalize on/off 等）を JSON ファイル（`data/guild-settings.json`）に永続化 |
| `botApi.js` | Web process から呼ばれる loopback-only 内部 Fastify API。`BOT_API_TOKEN` bearer 必須 |
| `deploy.js` | スラッシュコマンド定義を Discord API に登録するスクリプト（`node src/deploy.js`） |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `commands/` | 11 個のスラッシュコマンド実装（`export default { data, execute }`）（see `commands/AGENTS.md`） |
| `db/` | better-sqlite3 layer。Web process 専用（Bot process からは import されない）（see `db/AGENTS.md`） |
| `web/` | Fastify Web server と（ビルド成果物経由で配信される）React dashboard の server 側（see `web/AGENTS.md`） |

## For AI Agents

### Working In This Directory
- **循環インポート防止**: `sessions.js` が VC セッションの共有状態を保持するハブ。`index.js` と `commands/*.js` の双方向依存を作らないこと
- Bot process は `better-sqlite3` を絶対に import しない。DB が必要な操作は `src/web/server/` 経由の internal API を使う
- `player.js` のウォッチドッグは `state.playbackDuration` の増加を見て判定する。`stateChange` イベント自体はループ再生開始時にしか発火しないため使わない
- `#hadError` フラグは `queue.next({ forceAdvance: true })` を呼ぶ**前**に退避してからリセットする（順序が逆だと無限リトライになる）
- 音声ストリームは常に yt-dlp の stdout を直接 `createAudioResource` にパイプする（`--get-url` + FFmpeg 方式は使わない、詳細はルート `CLAUDE.md`）

### Testing Requirements
- 各モジュールに対応する `*.test.js` が同じディレクトリにある（`node:test` + `node:assert/strict`）
- `npm run test:server` で `scripts/run-node-tests.mjs` 経由で実行される

### Common Patterns
- スラッシュコマンドは `execute(interaction, sessions)` シグネチャで統一
- ユーザー向け返信は絵文字プレフィックス付きの日本語メッセージ（`❌`, `✅`, `⏸️` 等）
- VC 操作系コマンドは必ず `checkSameVoiceChannel(interaction, session)` を先頭でガードする

## Dependencies

### Internal
- `commands/` は `queue.js` / `permissions.js` / `sessions.js` / `queueEditorView.js` に依存
- `web/server/` は `db/` と `search.js` / `queue.js`（YouTube マッチング用）に依存

### External
- discord.js v14, @discordjs/voice ^0.19.2 以上
- yt-dlp（child_process 経由の外部バイナリ）, FFmpeg

<!-- MANUAL: -->
