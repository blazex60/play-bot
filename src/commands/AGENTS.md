<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-15 | Updated: 2026-07-15 -->

# commands

## Purpose

14 個のスラッシュコマンド実装。各ファイルは `export default { data: SlashCommandBuilder, execute(interaction, sessions) }` の形で 1 コマンドを定義する。`src/index.js` がこのディレクトリを `readdirSync` で走査してロードし、`src/deploy.js` が `data` を Discord API に登録する。両方とも `*.test.js` を除外して `.js` ファイルのみ走査するため、`play.test.js` のようなテストファイルを追加しても起動/デプロイには影響しない。

## Key Files

| File | Description |
|------|--------------|
| `play.js` | `/play` — URL（プレイリスト対応）またはキーワード検索で再生。`search.js` / `sessions.js` / `views.js` を使う。共通のキュー追加処理は `enqueueAndAnnounce`（同ファイル内）に集約 |
| `pause.js` / `resume.js` / `skip.js` / `stop.js` | 基本的な再生制御。VC 内ユーザーのみ。VC ガードは `requireSessionInSameVoice`（`../permissions.js`）で統一 |
| `queue.js` | `/queue` — `queueEditorView.js` の embed/ボタン UI でキュー一覧を表示 |
| `shuffle.js` | `/shuffle` — キューをシャッフル |
| `loop.js` | `/loop` — ループモードをオフ→1曲→キュー→オフの順に切り替え |
| `leave.js` | `/leave` — VC から退出しセッションを破棄 |
| `nowplaying.js` | `/nowplaying` — 現在再生中のトラックを embed 表示 |
| `bitrate.js` | VC のビットレートを Guild premium tier 上限内で設定 |
| `normalize.js` | Guild 単位の音量ノーマライズ on/off を `settings.js` に保存 |
| `autoplay.js` | `/autoplay mode/personalize/notify` — キュー枯渇時の自動再生モード・パーソナライズ・通知設定を `settings.js` に保存 |
| `help.js` | `/help` — コマンド一覧の embed 表示。Web ダッシュボードの `/help` ページへのリンクを含む |

## For AI Agents

### Working In This Directory
- 新規コマンドを追加する場合は既存ファイルと同じ `export default { data, execute }` 形式に揃える。`src/index.js` と `src/deploy.js` は自動的にこのディレクトリを走査するため、追加以外の登録作業は不要
- VC 操作を伴うコマンド（`pause`/`resume`/`skip`/`stop`/`loop`/`leave`/`shuffle`/`nowplaying`）は `requireSessionInSameVoice(interaction, sessions, { emptyMessage, isEmpty?, skipVoiceCheck? })`（`../permissions.js`）でセッション取得+VC 同席チェックをまとめて行う。新規コマンドを追加する際もこのヘルパーを使い、個別に `sessions.get` + `checkSameVoiceChannel` を書かない
- セッションが存在しない場合のエラーメッセージ（`❌ 再生中の曲がありません` 等）は既存コマンドの文言パターンに揃える（`emptyMessage` 引数で渡す）

### Testing Requirements
- コマンド単体の `*.test.js` はこのディレクトリには基本的に置かれていないが、`play.test.js`（`enqueueAndAnnounce` のユニットテスト）と `../helpCommand.test.js` が例外。それ以外のロジックは `queue.js` / `player.js` / `permissions.js` 側のユニットテストでカバーされている

### Common Patterns
- 返信は `interaction.reply(...)` または VC 未参加時は `interaction.deferReply({ ephemeral: true })` → `editReply`
- `MessageFlags.Ephemeral` はエラー・個人向け結果にのみ使う

## Dependencies

### Internal
- `../queue.js`（`LoopMode`, `createTrack`）
- `../permissions.js`（`requireSessionInSameVoice`, `checkSameVoiceChannel`）
- `../format.js`（`fmtDuration`, `LOOP_LABELS`）
- `../sessions.js`（`getOrCreateSession`, `pendingStore`）
- `../search.js`（`searchYoutube`, `resolveMetadata`, プレイリスト解決）
- `../views.js`, `../queueEditorView.js`
- `../settings.js`（`normalize.js`, `autoplay.js` コマンド）

<!-- MANUAL: -->
