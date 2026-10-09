# アーキテクチャリファクタリング実施報告

PR: https://github.com/blazex60/play-bot/pull/64

## 1. 調査で見つかった問題

- `src/` 直下に Discord adapter（commands/、botApi.js、deploy.js、index.js）、再生ドメイン（player.js・queue.js・sessions.js・autoplay.js・queueExhaustion.js）、インフラ（search.js・normalize.js・audio/・mix/）、共有ヘルパー（format.js・settings.js・webClient.js）、Web 専用 DB 層（db/）が全て混在し、責務の境界が読み取れなかった
- `player.js` が 3483 行で、再生オーケストレーションに加えて解析スケジューリング（analysis queue / stem queue dispatch、永続キャッシュ、miss-backoff）、ストール検出ウォッチドッグ、プリフェッチ管理など多数の責務を抱えていた
- `wasEmpty → add → announce → playNext` の enqueue パターンが play.js / botApi.js / recommendFlow.js / queueExhaustion.js / local/cli.js の 5 箇所に重複
- commands / botApi / local CLI / autoplay 系が `session.player.*` / `session.queue.*` を直接操作しており、adapters がドメイン内部の実装詳細に依存していた
- セッション破棄（player.stop + connection.destroy + pending 取消）が leave.js と index.js の VoiceStateUpdate に重複
- 循環インポート防止ルール（sessions.js から呼ばれる側は sessions.js を import しない getSession サンク方式）が存在したが、境界として明文化されていなかった

## 2. 採用した構成

```
Adapters (discord/ commands・botApi・main, local/ CLI)
        ↓
Application (playback/playbackService.js — in-process facade)
        ↓
Domain (playback/: sessions・player・queue・queueExhaustion・autoplay)
        ↓
Infrastructure (audio/, media/, shared/)
```

明示的に Player を HTTP API 化せず、PlaybackService は同一プロセス内の関数呼び出し facade とした（仕様通り）。web/（server + db）は Web process 専用層として独立。

## 3. モジュール境界

- `src/discord/` — Discord adapter。`main.js`（bot エントリーポイント）、`deploy.js`、`commands/`、interaction ハンドラ（queueEditorInteractions / recommendFlow / queueEditorView / views）、permissions / webPermission、loopback internal API `botApi.js`
- `src/playback/` — 再生ドメイン。`playbackService.js`（boundary）、`sessions.js`（SessionManager: sessions Map・joinVoiceChannel・destroySession・playbackFor）、`player.js`（GuildPlayer: 再生オーケストレーション/状態機械）、`queue.js`（GuildQueue）、`queueExhaustion.js`、`autoplay.js`、`player/`（player 補助モジュール群）
- `src/media/` — yt-dlp 連携（`search.js`）と MIX 曲順ロジック（`mix/`）
- `src/audio/` — 音声基盤（mixStream・pcmSource・解析・ステム・tempo・analysisQueue・normalize）
- `src/shared/` — adapter/domain 共有の純粋ユーティリティ（format・settings・webClient）
- `src/local/` — ローカル CLI adapter
- `src/web/` — server/（music-web process）と db/（better-sqlite3、Web process 専用）

依存方向は一方向（adapters → application → domain → infra）。`src/AGENTS.md` にルールを明記。

## 4. 移動したファイル（主なもの）

| 旧 | 新 |
|---|---|
| src/index.js | src/discord/main.js |
| src/deploy.js, src/botApi.js, src/commands/, src/views.js, src/queueEditorView.js, src/queueEditorInteractions.js, src/recommendFlow.js, src/permissions.js, src/webPermission.js | src/discord/ 配下 |
| src/player.js, src/queue.js, src/sessions.js, src/queueExhaustion.js, src/autoplay.js, src/player/ | src/playback/ 配下 |
| src/search.js, src/mix/ | src/media/ 配下 |
| src/normalize.js | src/audio/normalize.js |
| src/format.js, src/settings.js, src/webClient.js | src/shared/ 配下 |
| src/db/ | src/web/db/ |

併せて修正した機構的参照: `data/` への `__dirname` 相対パス3箇所（settings.js / deploy.js / db/index.js）、package.json scripts・`main`、Dockerfile CMD、QA manifest（src/db/sqlite.js→src/web/db/sqlite.js）、AGENTS.md/CLAUDE.md 類。

## 5. GuildPlayer から分離した責務

全て `src/playback/player/` 配下の DI クラスへ verbatim move（コメント・レビュー由来の注釈含む）。共有 Map/状態は coordinator の公開フィールド、player 内部への書き込みはコールバック注入という規約を共通適用。

| 分離先 | 内容 |
|---|---|
| `analysisCoordinator.js` (~427行) | トラック解析スケジューリング: `scheduleAnalysis`（staged-copy/stem-queue dispatch）、`lookupPersistentAnalysis`、`getCachedAnalysis`（miss-backoff）、`runAnalysis`、`resolveAnalysis` |
| `playbackWatchdog.js` (~75行) | `playbackDuration` 増加ポーリングのストール検出（10s interval / 30s threshold）。コールバック注入のみ |
| `sourcePreparer.js` (~868行) | プリフェッチ機構全体（prefetchKey/Entries/prefetchUpcoming/ensureFullPrefetch/ensureStemPrefetch/ensureAnalysisPrefetch/runLowPriorityStemPrefetch/discard*/getPrefetchedOrFetch）+ incoming source 準備（ensureIncomingPrep/takePreparedIncoming/cleanup/destroyPreparedSource）+ 両方向ステム準備 + `createPcmSource` |
| `transitionCoordinator.js` (~1168行) | `startCrossfadeArm`/`clearCrossfadeArm`/`#maybeStartCrossfade`（arm-tick・候補評価・ラダー dispatch）、評価済み遷移スタッシュ（stash/takeMatching）、`outgoingStemTempoFilter`、sessionTempo 系、`fallbackAnalysis`/候補除外/`normalizeTransitionPlan` |
| `mixerPipeline.js` (~332行) | MixStream 構築 + 7 イベント配線（trackend/sourceerror/incomingerror/snaphandoff/underrun/underrunClear/error）、`attachMixerResource`、PCM-wait 機構（waitForSourceAudio/inspect/supersede/discard/abort）、`recoverMixerPlayback`/`ensureMixerPlaying`、mixer 死亡判定 |
| `queueAdvancement.js` (~258行) | トラック終了後の進行（advanceAfterPlayback/drainAfterPlayback/handleAfter/tryHandleQueueExhausted）+ queueRefill クラスタ、handlingAfter/pendingAfter/playbackCount 管理 |
| `playback/sessions.js` の `destroySession` | player.stop + connection.destroy + pending recommend 取消の teardown 共通化 |

player.js は **3483 → 1009 行（-71%）**。残りは `playNext`/`#playNextMixer`/handoff 入口/`skip`/`stop`/`seekTo`/`pause`/`resume`/`#disconnect` と `getters` のオーケストレーション本体。回復系ポリシー（`shouldReconnectRetry`/`isShortTrack`）は既存 `playback/player/playbackPolicy.js` にあり、別抽出は行わなかった。

## 6. PlaybackService の公開 API

`playbackFor(sessionsMap)` / `playback` singleton で提供（commands は `execute(interaction, sessions)` の sessions Map を束縛する形で取得）。

- `hasSession(guildId)` / `queueIsEmpty(guildId)`
- `getState(guildId)` → `{active, current, upcoming[], isEmpty, loopMode, status, positionSec}` のスナップショット（live internals を返さない）
- `enqueue(guildId, tracks, {onEnqueued, awaitStart})` → `{wasEmpty, started}` または `null`。`onEnqueued` は必ず playNext の前に実行される
- `pause` / `resume` / `skip`（async）/ `stop`（async、player.stop 後に `onStop` hook 発火）
- `seekTo(guildId, sec)` → true/false/null（seek 失敗と no-session を区別）
- `shuffle` / `cycleLoop` / `removeUpcoming` / `moveUpcoming` / `reorderUpcomingIfUnchanged`

## 7. 除去した直接依存

- `session.player.*` / `session.queue.*` の参照は adapters・queueExhaustion から全て除去（grep でゼロを確認。残るのは sessions.js 内部と destroySession のみ）
- enqueue の重複ロジック 5 箇所 → `playback.enqueue` に統一
- botApi の `serializeSession`/`enqueueTracks`/`control`/`queue`/`import` エンドポイントは全て PlaybackService 経由
- recommendFlow は `new PlaybackService({getSession})` + `onEnqueued` で consumedRoundUserIds マークと followUp を実現
- local/cli.js は全コマンドを PlaybackService に委譲
- queueEditorView の `buildQueueEditorPayload` はスナップショット `{current, upcoming[], loopMode}` を受け取る形に変更（live queue を渡さない）

## 8. テスト結果

| 項目 | 結果 |
|---|---|
| `bun run test:server` | 817 pass / 0 fail / 2 skip（環境由来の ffmpeg/aubiotrack skip） |
| `bun run test:web` | 20 pass / 0 fail |
| `bun run typecheck` | OK |
| `bun run build:web` | OK (P0_VITE_BUILD_OK) |
| `bun run test:e2e` | 6/6 pass（VM に Playwright binary が無かったため `bunx playwright install chromium` 後に実行） |
| CI (PR #64) | CodeQL・GitGuardian・CodeRabbit 等 5 pass / deploy skip（PR のため） |
| 新規 PlaybackService テスト | 18 件（enqueue 順序・onEnqueued・awaitStart・seekTo 三値・queue 操作・スナップショット非共有等） |
| ローカル再生検証 | `bun run player --sink wav` で play→np→queue→pause→resume→skip→loop を実行、実音声出力を ffprobe/volumedetect で確認。6モジュール抽出後の最終 HEAD でも再検証（11.2s・-25.4dB mean） |

## 9. 残課題・確認されていない部分

- `player.js` の残り ~1000 行はオーケストレーション本体（playNext/handoff/transport API）。これ以上の分割は各ピースが互いに深く結合しており収穫逓減のため、今回の終点とした
- adapters の `session.connection.*`/`session.planToken` 直接読み取りは `playback/sessionAccessors.js`（leaf モジュール、sessions.js から re-export）の read-only ヘルパー経由に正規化済み。残る例外は local/cli.js shutdown の `dead.player.stop()`/`dead.connection.destroy()` のみ（CLI 自身が生成したローカルセッションの teardown であり、共有 session への read ではないため意図的に保持）
- playback ドメイン内部（queueExhaustion.js）は session の `autoplayContinuationUsed`/`recentPlayedVideoIds`/`textChannelId`/`planToken` に直接触れるが、これはドメイン所有の共有状態なので意図的に保持
- Discord 実接続・YouTube 実再生は本 VM では検証不可（サウンドカード無し・YouTube bot-check）。ローカル CLI の HTTP フィクスチャ経路で再生パス全体を検証した
- `web/server/` 側の import は機械的書き換えのみ（依存方向の縮小は今回のスコープ外）

## 10. 次に分けるべき箇所（優先度順）

§5 の6モジュール抽出で計画していた SourcePreparer・TransitionCoordinator・StemPreparationCoordinator（→ SourcePreparer に吸収）・PlaybackRecovery（→ 既存 playbackPolicy.js で充足）は完了。残りの候補:

1. **session フィールド読み取りの正規化** — ✅ 完了（sessionAccessors.js 導入、adapter 側の直接参照ゼロを grep 確認）
2. **sessions.js の SessionManager 化** — sessions Map・joinVoiceChannel・destroySession・playbackFor を束ねるクラス/モジュール境界として明示し、Map の直接 export を減らす。extract 群が落ち着いた後の段階として適切
3. **queueEditorInteractions のセッション取得整理** — 現状 `sessions.get` + queue 参照の組み合わせ�� adapter 側に残っている（PlaybackService 側に状態問い合わせ API を追加する選択肢）
