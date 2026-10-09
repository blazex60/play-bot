# アーキテクチャ境界 監査・修正 最終報告（Phase 3 仕様）

PR: https://github.com/blazex60/play-bot/pull/64
対象ブランチ: `devin/1791348378-arch-refactor`（同 PR のブランチにコミットを積み増し。新規 PR は作らず、PR #64 もマージしていない）
対象コミット: `2841657` / `c076934` / `be58ecf` / `ad48f4e`（本ラウンド追加分 4 コミット）

## 1. 発見した設計上の問題（Phase 1 監査）

1. **playback → discord 逆依存** — `src/playback/sessions.js` が `src/discord/recommendFlow.js`（おすすめ取消・プロンプト投稿）を、`src/playback/queueExhaustion.js` が同じく recommend 系関数を import し、views.js の `PendingChoiceStore` にも依存していた。依存方向ルール（adapters → application → domain → infra）に対する明確な違反。
2. **`PlaybackService.enqueue()` の非同期窓** — `wasEmpty → add → await onEnqueued → playNext` の await 中にセッション破棄・queue.clear・セッション置換が起きると、破棄済み/置換済みセッションに対して playNext が走る。
3. **`playbackFor(sessionsMap)` の onStop が注入 Map を見ていない** — `bumpPlanToken`/`cancelPendingRecommendations` がグローバル `sessions` を直接参照し、注入された Map に束縛されたサービスでは plan 取消が効かない。
4. **`getState()` が共有ミュータブル参照を返す** — `current`/`upcoming[]` の要素がキュー内部の同一 track オブジェクトで、呼び出し側のミューテートがドメイン状態を壊し得た。
5. **queue editor が index 操作のみで staleness を検査** — `selectedIndex < len` しか見ておらず、描画後に前方の曲が消えた場合、別の曲に誤爆する。
6. **sessions.js の責務混在** — Map 所有・セッション生成/破棄・recommend 用ストア・plan 管理・webClient singleton が同居（Phase 6 で再評価、§7）。

## 2. 確認済みバグ vs 潜在的リスク

**確認済みバグ（再現パスが特定できたもの）**
- enqueue の `onEnqueued` await 中に leave/destroy → 破棄済みセッションで `playNext()` が走り、leave 後に再生が復活し得る
- await 中に `/stop`（`queue.clear()`）→ enqueue A の曲が消え、`wasEmpty=true` で並走した enqueue B と A が両方 `playNext()` → 二重開始
- セッション置換（leave→即 rejoin）時、古い autoplay continuation が `isStale()` チェックと enqueue 呼び出しの間に新セッションへ曲を追加 — 旧操作が新セッションを汚染
- `playbackFor(注入Map)` で onStop がグローバル Map を触るため、テスト束縛時に `bumpPlanToken`/`cancelPendingRecommendations` が実質無効

**潜在的リスク（コード上成立、発生頻度は低い）**
- getState 経由で返した track へのミューテートがキュー内部を破壊（現行呼び出し側は表示のみだが契約上危険）
- queue editor の index 操作の誤爆（2人が同時に触った場合など）

## 3. 依存方向の修正（Phase 2・P0）

- `PendingChoiceStore` を `src/shared/pendingChoiceStore.js` に移動（views.js から摘出）。adapter/playback 両方が参照できる共有層へ。
- 新設 `src/discord/recommendHooks.js` — adapter 側の composition root。`{ cancelRecommendations, hasPendingForGuild, postRecommendationPrompt }` を束ねる。
- `getOrCreateSession({..., recommendHooks})` で hooks を注入し `session.recommendHooks` に保持。未注入時は `NOOP_RECOMMEND_HOOKS` で正規化（テスト/CLI はそのまま動く）。
- teardown/onStop/queueExhaustion の全経路が注入 hooks 経由になり、`src/playback/` → `src/discord/` の import は **ゼロ**（grep 検証済み）。抽象化は inject される関数3本と no-op 既定のみで、interface/抽象クラスは作っていない（仕様の「必要最小限」に合致）。

## 4. 非同期競合対策（Phase 3・P0）

`PlaybackService.enqueue(guildId, tracks, { onEnqueued, awaitStart, expectedSession })`:

- **入口の同一性検証**: `expectedSession` 指定時、現在の live セッションと不一致なら即 `{wasEmpty:false, started:false}` — 古い autoplay continuation が新セッションを汚染するパスを遮断。
- **await 後の再検証**: `onEnqueued` の await 完了時に `this.#getSession(guildId) !== session` なら `{wasEmpty, started:false}` — leave/destroy/置換中の playNext 復活を遮断。
- **二重開始ガード**: `wasEmpty` でも、開始するのは `tracks.includes(session.queue.current)` が真の場合のみ — stop-clear 後に並走した別 enqueue が head を取った場合、古い側は開始しない。
- `queueExhaustion.js` は `expectedSession: session` を渡す。`playbackFor` の `onStop` は束縛 `sessionsMap` を `bumpPlanToken`/`cancelPendingRecommendations` に渡すよう修正（両関数は `(sessionsMap, guildId)` シグネチャに変更）。
- 排他ロックは導入せず（仕様どおり）、非同期窓の前後で「自分が見ていたセッションが今も live か」を検証する世代検証方式。`onEnqueued` の順序保証と `awaitStart` 契約は維持。

## 5. PlaybackService API 変更

| API | 変更 |
|---|---|
| `enqueue` | `expectedSession` オプション追加、戻り値は従来どおり `{wasEmpty, started}|null`（stale 時は `started:false`） |
| `getState` | `revision` フィールド追加（queue の楽観的並行制御トークン）。返す track は不変化済み（§6参照ではなく §4-5: `createTrack` で `Object.freeze`、`queue.add` でも追加経路を freeze） |
| `removeUpcomingIfRevision` / `moveUpcomingIfRevision` | 新規。`expectedRevision` 不一致時 `'stale'`、無 session は `false` |
| その他（pause/resume/skip/stop/seekTo/shuffle/cycleLoop/removeUpcoming/moveUpcoming/reorderUpcomingIfUnchanged） | 変更なし |

`sessions.js` 側: `bumpPlanToken(sessionsMap, guildId)` / `cancelPendingRecommendations(sessionsMap, guildId)` が Map 第一引数を取る形に変更（呼び出し側: botApi.js, commands/autoplay.js 更新済み）。`getOrCreateSession` が `recommendHooks` を受け付け、session オブジェクトに `recommendHooks` フィールドが追加。

## 6. queue revision 設計（Phase 5・P1）

- `GuildQueue.#revision`（private int）を `#tracks`/`#currentIndex` の全ミューテーションでインクリメント: `add`/`clear`/`shuffle`/`next`（実際に進んだ時）/`removeUpcoming`/`moveUpcoming`/`reorderUpcomingIfUnchanged`（実適用時のみ）。`cycleLoop` は bump しない（loopMode 変更は index 意味論に無関係）。
- `getState()` が `revision` を返し、`buildQueueEditorPayload` が custom_id（`qedit_<action>_p<page>_i<index>_r<rev>`）と select 値（`<index>:r<rev>`）に埋め込む。100 文字制限内。
- `CUSTOM_ID_RE` の `_r` は optional — デプロイ前の旧メッセージはパース成功し、ミューテーション系は `revision=null` ≠ live revision で `'stale'` 警告になる（旧仕様の silent no-op より安全）。読み取り系（select/page/close）は従来どおり動く。
- stale 時の挙動は既存パターンを維持: 最新 state で `interaction.update` + ephemeral `⚠️ キューが変更されました。もう一度選択してください` + `logQueueOp(interaction,false,'stale_revision')`。権限チェック（`checkCommandAllowed`/`checkSameVoiceChannel`）は順��含め無変更。
- 重複 videoId は天然に安全（同一性ではなく「キューが変わったか」で判定するため）。

## 7. SessionManager の扱い（Phase 6・P1・評価のみ）

結論: **モジュール形式を維持（クラス化しない）**。根拠:

- `sessions.js` は 216 行。Map 所有・`getOrCreateSession`/`destroySession`/`playbackFor`・plan/recommend ライフサイクル・履歴記録を担うが、全関数が `sessionsMap` を明示引数で受け取る設計になっており、テスト束縛性は既にある。
- クラス化は 15+ 箇所の named import 全てを書き換えるだけで、境界の正しさ・状態所有・非同期安全性に寄与しない。仕様の「行数削減目的の分割は非目標」「不要な抽象化禁止」に反する。
- 残る境界上の匂い（残課題として記録）: `pendingStore`/`recommendPendingStore`/`recommendRounds` は Discord interaction 側の状態なのに playback ハブにインスタンスが置かれている。`discord/` 側への移設は可能だが recommendFlow/main/play の import 先変更が必要で、効果が小さいため今回は見送り。

## 8. 変更ファイル（本ラウンド）

| コミット | ファイル |
|---|---|
| `2841657` Phase 2 | `src/shared/pendingChoiceStore.js`(新), `src/discord/recommendHooks.js`(新), `src/playback/{sessions,queueExhaustion}.js`, `src/discord/{botApi,commands/play,views}.js`, `src/AGENTS.md`, テスト |
| `c076934` Phase 3 | `src/playback/{playbackService,sessions,queueExhaustion}.js`, `src/discord/{botApi,commands/autoplay}.js`, playbackService.test.js (+148) |
| `be58ecf` Phase 4 | `src/playback/{queue,playbackService}.js`, queue.test.js/playbackService.test.js (+75) |
| `ad48f4e` Phase 5 | `src/playback/{queue,playbackService}.js`, `src/discord/{queueEditorInteractions,queueEditorView}.js`, 各テスト (+250) |

## 9. 新規テストと実行結果

**新規テスト（合計 +325 行程度）**
- playbackService.test.js: enqueue stale-session（leave 中/置換中/expectedSession 不一致）・二重開始防止・`getState` の freeze スナップショット・`removeUpcomingIfRevision`/`moveUpcomingIfRevision` 契約
- queue.test.js: `#revision` が全ミューテーションで bump・読み取り/loopMode で不変、track の freeze
- queueEditorInteractions.test.js: stale revision で remove/move/jumpmodal が警告+無変更・重複 videoId で誤爆しない・pre-deploy custom_id（`_r` 無し）が stale 警告になる・`stale_revision` ログ記録

**実行結果（最終 HEAD `ad48f4e` の `bun run check`）**

| 項目 | 結果 |
|---|---|
| `bun run test:server` | 853 pass / 0 fail / 2 skip（aubiotrack 未インストール由来、既存） |
| `bun run test:web` | 20 pass |
| `bun run typecheck` / `build:web` | OK |
| `bun run test:e2e` | 6/6 pass |
| CI | 前回同様 pass 見込み（走行中は PR ページ参照） |

既存テストの削除・弱体化はゼロ（追加と必要最小限のフィクスチャ更新のみ）。

## 10. 未解決の負債

- `pendingStore`/`recommendPendingStore`/`recommendRounds` のインスタンスが sessions.js（playback ハブ）所有 — `discord/` 側への移設候補（低優先）
- `player.js` 残り ~1000 行はオーケストレーション本体（非目標どおり分割なし）
- queue editor の revision 方式は「キューの任意変更」で stale になる — 厳しめだが誤爆より安全側。必要なら後日「対象 index 以降のみ変更」を表す細粒度トークンに進化させられる
- 旧メッセージの custom_id 後方互換: 読み取り系は動作、ミューテーション系は stale 警告（silent 失効より安全だが UX 差分として認識）
- Discord 実接続・YouTube 実再生は VM 上で検証不可（継続して残る既知の制約）
