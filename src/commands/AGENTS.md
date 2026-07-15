<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# commands

## Purpose

11 個のスラッシュコマンド実装。各ファイルは `export default { data: SlashCommandBuilder, execute(interaction, sessions) }` の形で 1 コマンドを定義する。`src/index.js` がこのディレクトリを `readdirSync` で走査してロードし、`src/deploy.js` が `data` を Discord API に登録する。

## Key Files

| File | Description |
|------|--------------|
| `play.js` | `/play` — URL（プレイリスト対応）またはキーワード検索で再生。`search.js` / `sessions.js` / `views.js` を使う |
| `pause.js` / `resume.js` / `skip.js` / `stop.js` | 基本的な再生制御。VC 内ユーザーのみ |
| `queue.js` | `/queue` — `queueEditorView.js` の embed/ボタン UI でキュー一覧を表示 |
| `shuffle.js` | `/shuffle` — キューをシャッフル |
| `loop.js` | `/loop` — ループモードをオフ→1曲→キュー→オフの順に切り替え |
| `leave.js` | `/leave` — VC から退出しセッションを破棄 |
| `nowplaying.js` | `/nowplaying` — 現在再生中のトラックを embed 表示 |
| `bitrate.js` | VC のビットレートを Guild premium tier 上限内で設定 |
| `normalize.js` | Guild 単位の音量ノーマライズ on/off を `settings.js` に保存 |

## For AI Agents

### Working In This Directory
- 新規コマンドを追加する場合は既存ファイルと同じ `export default { data, execute }` 形式に揃える。`src/index.js` と `src/deploy.js` は自動的にこのディレクトリを走査するため、追加以外の登録作業は不要
- VC 操作を伴うコマンドは `checkSameVoiceChannel(interaction, session)`（`../permissions.js`）を必ず先頭でガードする（`normalize.js` や `leave.js` のような VC 不問のコマンドを除く）
- セッションが存在しない場合のエラーメッセージ（`❌ 再生中の曲がありません` 等）は既存コマンドの文言パターンに揃える

### Testing Requirements
- コマンド単体の `*.test.js` はこのディレクトリにはない。ロジックは `queue.js` / `player.js` / `permissions.js` 側のユニットテストでカバーされている

### Common Patterns
- 返信は `interaction.reply(...)` または VC 未参加時は `interaction.deferReply({ ephemeral: true })` → `editReply`
- `MessageFlags.Ephemeral` はエラー・個人向け結果にのみ使う

## Dependencies

### Internal
- `../queue.js`（`LoopMode`, `createTrack`）
- `../permissions.js`（`checkSameVoiceChannel`）
- `../sessions.js`（`getOrCreateSession`, `pendingStore`）
- `../search.js`（`searchYoutube`, `resolveMetadata`, プレイリスト解決）
- `../views.js`, `../queueEditorView.js`
- `../settings.js`（`normalize.js` コマンドのみ）

<!-- MANUAL: -->
