# Phase 3 最終監査・マージ前修正 — 最終報告

PR: https://github.com/blazex60/play-bot/pull/64
対象ブランチ: `devin/1791348378-arch-refactor`（同ブランチに2コミット積み増し。新規 PR なし・マージなし）
基準コミット: `ad48f4e` → 最終 HEAD: `94061d3`

## 1. 確認済みの不具合（実際に壊れていた窓）

1. **stop() の async cleanup 中の playNext が誤 disconnect を引き起こす** — stop の `queue.clear()` 後〜cleanup await 中に走った playNext は `queue.current` が空になり、`!track → #disconnect()` 経路で **VC 切断まで発火**し得た（/stop が /leave 化するバグ）。または cleanup 途中の mixer に setCurrent して半壊状態で再生が残る。
2. **source 準備中に stop が開始した playNext の半存続** — `#playNextMixer` の prep/PCM-wait await 中に stop が割り込むと、rebuild 済み mixer に対して source がセットされ、停止すべき再生が残った。
3. **advancement drain / queue refill が stop の teardown 窓で enqueue → revive** — `#handleAfter`/`maybeRefillQueue` が stop 中に走ると、stop 済みキューに autoplay/refill 経路で曲が載り再生が復活し得た。
4. **onStop が置換セッションに着弾** — `await player.stop()` 中に leave+rejoin で Map エントリが差し替わると、旧 stop の完了通知（planToken bump + recommend 取消）が**新セッション**に作用した。
5. **in-flight 推薦処理が stop 開始時点で無効化されない** — invalidation が teardown 完了後だったため、stop の cleanup 窓で推薦 plan が enqueue できた。
6. **queue revision のセッション間衝突** — `#revision` がキューごとに 0 開始のため、破棄セッション A 時代のエディタ（revision=2）が、同じ revision=2 に達した新セッション B のキューを誤操作できた（spec の再現手順どおり成立）。

**潜在的リスク（機構上成立・発生頻度低）として塞いだもの**: 重複 stop() 同士の teardown 交差（`#stopTail` で直列化して同時に解消）。

**監査して問題なしと確認した箇所（変更していない）**:
- `enqueue` の session-identity ガード（`expectedSession` + await 後再検証）は前回の修正で成立済み — 今回は stop 世代ガードを追加したのみ
- `reorderUpcomingIfUnchanged` の snapshotIds 方式（mix-optimize 経路）は identity ベースで revision とは別問題として既に安全
- 読み取り系 editor アクション（select/page/close/jump modal 表示）は再描画のみで mutation を伴わないため revision/queueId ガード不要と確認
- `destroySession` 自体の teardown 順序（player.stop → connection.destroy → pending 取消）は前回・今回の監査ともに問題なし

## 2. 修正内容

**コミット `2f4ba99` — stop ライフサイクルの世代管理（P0）**

- `GuildPlayer`: `#stopGeneration`（stop() 開始時に同期 +1）、`#stopping`、`#stopTail`（直列化・never-reject の待機点）。公開 getter: `stopGeneration`/`isStopping`/`stopTail`。
- `playNext`: entry で `isStopping` なら `stopTail` を待って abandon（disconnect しない）。`#playNextMixer` は prep 失敗時・prep 成功時・PCM-wait 後の3箇所で generation を再検証し、overtake 時は source を破棄して return。
- `QueueAdvancement`: `#handleAfter`/`maybeRefillQueue` 先頭に `isStopping()` ガード — stop 中の drain/refill が enqueue→revive を起こさない。
- `PlaybackService.enqueue` 契約（JSDoc 記載）: **tracks は live session のキューに常に載るが、entry 時に stop 中、または await 中に stopGeneration が進んだ場合は `started:false`・playNext 非呼出**。entry 前に完了した stop は新規開始を妨げない（/stop → /play の正常経路は維持）。
- `PlaybackService.stop` 契約変更（影響範囲を明示）: 新 hook `onStopStart(guildId, session)` が **teardown 開始前**に発火し、入口で捕捉した session オブジェクトに直接作用（`session.planToken += 1` + `session.recommendHooks.cancelRecommendations`）— Map 経由でないため leave+rejoin で誤爆しない。`onStop(guildId, session)` は stop 完了後、**その session がまだ live な場合のみ**発火。sessions.js では両 hook に session-bound `invalidateSession` を束ねた（map-bound helper は廃止せず他用途で残置）。影響範囲: `playbackFor` の配線のみ — 外部呼び出し側の変更なし。

**コミット `94061d3` — revision + queue identity（P1）**

- `GuildQueue.#id = ++nextQueueId`（モジュールカウンタ・プロセス内一意・決定的）を追加し `get id()` で公開。
- `getState()` が `queueId` を返す。custom_id は `qedit_<action>_p<page>_i<index>_r<rev>_q<id>`、select 値は `<index>:r<rev>:q<id>`（100 文字制限内）。
- `CUSTOM_ID_RE` の `_q` は `_r` と同じく optional — 旧形式メッセージは `queueId=null` で parse され、live queue id と不一致 → ミューテーション系は `'stale'` 警告。読み取り系は従来どおり動作。
- `removeUpcomingIfRevision`/`moveUpcomingIfRevision` が第4引数 `expectedQueueId` を受け、`queue.id` 不一致でも `'stale'`。`jumpmodal` も modal custom_id で継続。

## 3. テスト結果

**新規テスト（全て Promise 解決を deferred で制御した決定的テスト、sleep なし）**

- playbackService.test.js: stop 中 entry で `started:false`・await 中に stop が始まった場合・expectedSession continuation が stop 中に revive しない・entry 前完了の stop は開始を妨げない、`onStopStart` が teardown 前に発火・置換セッションに completion hook が着弾しない、queueId 不一致で `'stale'`（+125 行）
- player.test.js: stop teardown 中の playNext が abandon・prep 中 overtake が disconnect しない・prep 失敗 overtake が drain を kick しない・stop 完了後の新 playNext が壊されない・stop 後の新規キュー投入が再生可（+95 行）
- sessions.test.js: `playbackFor` の stop invalidation が停止対象セッションに開始時点で着弾し replacement には触れない（+38 行）
- queue.test.js: `queue.id` の一意性・ミューテーションで不変（+24 行）
- queueEditorInteractions.test.js: spec の再現（セッション破棄→置換→同 revision の旧ボタンが新キューを触らない）、`_r` あり `_q` なしでも stale（+83 行）

**最終 HEAD `94061d3` の `bun run check`**

| 項目 | 結果 |
|---|---|
| `bun run test:server` | **871 pass / 0 fail / 2 skip**（aubiotrack 未インストール由来の既存 skip） |
| `bun run test:web` | 20 pass |
| `bun run typecheck` / `build:web` | OK |
| `bun run test:e2e` | 6/6 pass |

既存テストの削除・弱体化なし（追加のみ）。環境依存で実行不可の項目はなし。

## 4. 未解決事項

- `pendingStore`/`recommendPendingStore`/`recommendRounds` のインスタンスが sessions.js（playback ハブ）所有 — 前回監査から継続の残課題（`discord/` 移設候補・低優先）
- `#stopTail` は直列化するが stop 同士は相互排他のみ — enqueue と stop の間に await-all キューは作っていない（enqueue は tracks を載せて `started:false` で返る契約。ユーザーの /play は新しい enqueue を発行するため実害なし）
- queueId はプロセス再起動で 0 に戻る — メモリ内トークンのため再起動を跨ぐ旧メッセージは stale 扱いで安全側に倒れる（永続化不要と判断）
- Discord 実接続での手動確認は VM 上不可（継続する既知の制約）
