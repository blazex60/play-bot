# PR #64 最終競合監査と修正 — 最終報告

PR: https://github.com/blazex60/play-bot/pull/64
対象ブランチ: `devin/1791348378-arch-refactor`（同ブランチに2コミット積み増し。新規 PR なし・マージなし）
基準コミット: `94061d3` → 最終 HEAD: `d92b7c5`
今回をアーキテクチャリファクタリングの最終修正とし、新たな大規模再設計は行っていない。

## 1. 確認できた不具合

### Item 1: Queue ID の再起動後衝突【P0】— 確認済みバグ（設計上成立）

`GuildQueue.#id = ++nextQueueId` はプロセス内カウンタのため、Bot 再起動で 0 に戻る。Discord に残存する旧プロセスの Queue Editor メッセージ（例: `_r2_q3`）は、再起動後に同じ `queueId=3`・`revision=2` に達した新 Queue のエディタとして受理され得た → 前回導入した楽観的競合制御を再起動またぎで回避する経路。

### Item 2: QueueAdvancement の await 後競合【P0】— 確認済みバグ 4 件 + 潜在 1 件

`#handleAfter` は入口で `isStopping()` を見るだけで、await 復帰後の再検証がなかった。await 中に stop() が**開始されて完了まで**進むと `isStopping` は false に戻り、stale drain が走り続けた:

| 箇所 | 実害 |
|---|---|
| `cleanupCurrentTempFile()` / `cleanupIncomingTempFile()` 後 | stale drain が `queue.next()` → `playNext` → refill → `disconnect()` を実行（確認済み） |
| reconnect retry の `sleep(2000)` 後 | 猶予中に stop 完了で `isStopping=false` に戻り、再構築済み mixer 上で `playNext` が再生を復活（確認済み） |
| `#startQueueRefill` の await 後 | `handled=false` の stale 結果で stop 完了後に `disconnect()`（確認済み） |
| drain ループ `while (pendingAfter)` | イテレーション間に完了した stop を周回ごとの再スナップショットでは取りこぼす（潜在） |
| `maybeRefillQueue().then(prefetchUpcoming)` | クリア済みキュー上ではほぼ no-op だが同パターン（潜在扱いでガード） |

### Item 3: 周辺の非同期処理 — seekTo は実バグ（修正済み）、他は問題なし

- **`seekTo` — 実バグで修正**: `createPcmSource`（stream 経路）と `waitForSourceAudio` の 2 await を跨いで `adoptCurrent` + arm/bookkeeping を実行していた。既存の `pcmWaitGeneration`/`queue.current` 変位チェックは teardown「開始後」の stop しか捕捉できず、**entry 済み・teardown 未実行**の stop（世代は bump 済み）を素通りさせ、再構築済み mixer に source が載り得た。
- **`#onSnapHandoff`/`#onCrossfadePromoted` — 問題なし（変更なし）**: await は末尾の temp クリーンアップのみで、復帰後に再生状態へ作用する事後処理がないため安全。
- **`#playNextMixer` — 問題なし（変更なし）**: 前回修正で prep 失敗時・prep 成功時・PCM-wait 後の 3 箇所 generation 再検証済み。
- 各 `await playNext` 直後は即 return で事後処理なし + playNext 自身のガードあり → 非バグ。`#tryHandleQueueExhausted` 内部の await 後にアクションなし → 呼び出し側のチェックでカバー。

## 2. 修正内容

### `6333f5a` — Queue ID を `crypto.randomUUID()` 化

- `src/playback/queue.js`: `import { randomUUID } from 'node:crypto'`、`#id = randomUUID()` に変更。モジュールカウンタ `nextQueueId` を削除。永続化なし・`revision` 仕様は不変。
- `playbackService.js`: `getState().queueId` は文字列化した UUID を返す。`*IfRevision` の比較は文字列等価。
- `queueEditorView.js`/`queueEditorInteractions.js`: custom_id は `..._r<rev>_q<uuid>`、select 値は `<idx>:r<rev>:q<uuid>`。`CUSTOM_ID_RE` の `_q` は hex+dash を受理。
- **旧形式の安全な失効**: `_q` なし・数値 `_q` の旧メッセージは parse されるが live queue id と不一致 → ミューテーション系は `'stale'` で警告拒否。select/page 等の読み取り系は従来どおり動作（互換維持）。
- **100 文字制限**: 最長ケース（jumpmodal + 36 文字 UUID）でも約 60 文字台で余裕。制限超過なしはテストで担保。

### `d92b7c5` — QueueAdvancement の generation 再チェック + seekTo ガード

- `QueueAdvancement` の deps に `stopGeneration: () => number` を注入（player.js、`isStopping` と同じ最小限の callback injection。新規配線なし）。
- `#drainAfterPlayback`: drain 開始時に generation を **1 回だけ**スナップショット → `#handleAfter(generation)` へ引き渡し。`while (this.pendingAfter && this.#stopGeneration() === generation)` でループ継続条件にも組み込み。
- `#handleAfter`: 入口 `isStopping() || generation 不一致` で return。以下の全 await 後に generation 再検証: `cleanupCurrentTempFile`、`cleanupIncomingTempFile`（`!preserveIncoming` 分岐内）、reconnect `sleep(2000)`、`#startQueueRefill`（stale 時は `pendingGaplessFrom` をクリアして disconnect せず中断）。
- `maybeRefillQueue`: refill 開始前にスナップショット、`.then` で再チェックしてから `prefetchUpcoming`。
- `player.js` `seekTo`: entry `if (this.#stopping) return false` + generation スナップショット + source 準備後・PCM-wait 後の 2 回再検証（stale 時は source を destroy して `false` を返す）。
- **設計上の要点**: generation 比較は `isStopping` が false に戻った「完了済み stop」も捕捉する（isStopping 単独では検知不能）。既存の `pendingAfter`/`handlingAfter` drain 仕様は維持。

## 3. 新規テスト（全て deferred Promise 制御の決定的テスト、sleep なし・既存テストの削除/弱体化なし）

**`6333f5a` 分（+132 行）**
- queue.test.js: 全 `GuildQueue` が UUID 形式の一意な id を持つ・独立プロセス相当の新規インスタンスでも衝突しない
- queueEditorInteractions.test.js: legacy 数値 `_q` が live revision でも stale、`_q` なしでも stale、jumpmodal custom_id が UUID 込みで 100 文字以内
- queueEditorView.js 経由: レンダリングされた全 custom_id・select 値が 100 文字以内

**`d92b7c5` 分（player.test.js +218 行、7 本）**
- cleanup await 中に stop 開始 → `queue.next` 不発
- cleanup 中に stop 開始 → `disconnect` 不発
- await 中に stop が開始かつ完了（`isStopping` 復帰）→ stale drain は再開しない
- refill 待機中に stop → stale 結果で `disconnect` 不発
- 通常の曲終了 → 次の曲へ進む（回帰）
- 通常の skip → 次の曲へ進む（回帰）
- trackend drain が stop に overtaken → refill・disconnect 不発

## 4. テスト結果 — 最終 HEAD `d92b7c5` の `bun run check`

| 項目 | 結果 |
|---|---|
| `bun run test:server` | **881 pass / 0 fail / 2 skip**（aubiotrack/ffmpeg 未インストール由来の既存 skip、前回と同じ） |
| `bun run test:web` | 20 pass |
| `bun run typecheck` / `build:web` | OK |
| `bun run test:e2e` | 6/6 pass |

フォーカス実行（player.test.js / playbackService.test.js / sessions.test.js / queue.test.js / queueEditorInteractions.test.js）: 133 pass / 0 fail。環境依存で実行不可の項目はなし。

## 5. 残存するリスク

- **UUID でも理論上の衝突確率は残るが実用上ゼロ** — 122bit ランダムで同一ギルドの旧パネルが新キュー id と一致する確率は無視できる。永続化不要の判断を維持。
- **`_q` を読まない独自クライアント/古いビルドの bot は stale を返し続ける** — 同時デプロイでない限り発生しない。旧フォーマット自体は安全側に失効するため被害は「古いパネルが効かない」だけ。
- **advancement 以外の長い await は監査範囲外** — `#tryHandleQueueExhausted` 内部等は復帰後アクションがなく安全と確認済み。今後新しい await を追加する場合は同パターンの generation 再検証が必要（AGENTS.md レベルの規約化は今回のスコープ外）。
- **Discord 実接続での確認は VM 上不可**（継続する既知の制約。実再生経路はローカルプレイヤー wav sink で検証済み）。

## 6. PR #64 をマージ可能か — **マージ可能と判断する**

- 指摘 2 件はいずれも実害のある競合として再現・修正し、決定的テストで退行防止済み
- 周辺監査（Item 3）で seekTo の実バグを追加で塞ぎ、他経路は問題なしの根拠を記録
- `bun run check` 全緑・既存テスト無改変・既存の再生動作（曲終了・skip・autoplay・refill・/stop→/play の正常経路）は回帰テストで維持を確認
- アーキテクチャ境界（adapters → PlaybackService → playback → audio/media、playback→discord import ゼロ）は本ラウンドでも維持

**推奨**: 実 Discord 環境へのデプロイ後にキュー編集パネルの動作確認（これのみ VM で検証不可）。
