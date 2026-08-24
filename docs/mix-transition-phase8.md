# MIX ステム分離つなぎプラン（Phase 8）

対象リポジトリ: `blazex60/play-bot`
配置先: `docs/mix-transition-phase8.md`
前提文書: [`docs/mix-plan.md`](mix-plan.md) / [`docs/mix-transition-phase7.md`](mix-transition-phase7.md)

---

## 0. この文書の使い方

`mix-transition-phase6.md`/`mix-transition-phase7.md` と同じ運用。各 Step の「完了条件」を受け入れ基準として使う。
未決事項の閾値は仮値のまま実装し、実機キャリブレーションは完了条件に残す。

この文書は `docs/mix-transition-phase7.md` §22「Phase 8 候補 — Stem Mixing」を継承・上書きする。§22 が Phase 7 から意図的に外した理由（CPU負荷・cache/temp file 管理の複雑さ・stem artifact の品質影響・Beatmatch/Phrase Mix 問題との分離評価の必要性）は本文書でも解決されたわけではなく、§21「未決事項（仮値）」に明記した通り引き続き未検証・未計測のまま実装している。同様に、§23「非目標」の "stem mixing" 行は Phase 8 の実装によって上書きされる。

---

## 1. 何を追加するか

Phase 7 のビートミックス（`planBeatmixTransition()`）は、出る曲の歌がまだ鳴っている退出点を**必ず却下する**（`findExitCandidates()` の `lastVocalEndSec` フィルタ）。理由は単純で、フルミックス同士を重ねる限り「出る曲の歌」と「入る曲の歌」が物理的に衝突しうるからだ（`docs/mix-transition-phase7.md` 禁止5）。

Phase 8 は、出る曲・入る曲の両方を Demucs でボーカル/伴奏の 2 stem に分離し、重畳区間だけ 4 本の PCM を独立したゲイン包絡で混ぜる。

```text
outgoing vocal       ───────╲
outgoing instrumental ─────────────╲
                                     ╳
incoming instrumental          ╱────────────
incoming vocal                       ╱────────
```

こうすると、出る曲の歌がまだ残っている退出点でも、**入る曲の歌をその歌が消えるまで単純に遅らせて開始する**だけで、ミックス後の信号には歌と歌の衝突が一度も現れない。これが Phase 8 が実際に増やす能力のすべてであり、それ以外（テンポ同期・ダウンビート整合・拍数フィッティング）は Phase 7C の `planBeatmixTransition()` をそのまま再利用する。

### 1.1 スコープ外（このPRでは実装しない）

- 4-stem（drums/bass/other）分離。vocals/instrumental の 2-stem のみ
- stem ごとの独立テンポストレッチ。同一曲の 2 stem は常にその曲のセッションテンポを共有する（`applySessionTempo`/`tempoFilter` は今まで通り曲単位）
- ユーザー向けコマンド/トグル。beatmix と同様、完全自動・キャッシュ有無だけで発火判定する
- stem 分離品質のスコアリング/ゲート。Demucs の出力をそのまま使う（vocalActivity.js の RMS 判定用途に対する既存の扱いと同じ）
- incoming 側の「エントリそのものが歌の前」という制約の緩和。§3 参照（outgoing 側のみ緩和するスコープカット）
- `#ensureAnalysisPrefetch()`（2〜3 曲先の先読み）への配線。§21 参照

---

## 2. 禁止事項の再確認（`docs/mix-transition-phase7.md` §24）

### 禁止5「vocal safety より phrase/BPM を優先しない」の再定義

§24 が書かれた時点の「歌の衝突」とは、フルミックス同士を重ねたときに**実際に鳴る音**として歌と歌が同時に聞こえることを指す。Phase 8 はこの実際の帰結を一切変えない — `buildStemEnvelopes()` が作る `inVocal` の開始オフセットは `outVocal` が完全に無音（ゲイン 0）になった後（+ `vocalCrossoverMarginSec` の余裕）にしか来ないため、ミックス後の出力で歌と歌が同時に鳴ることは Phase 7 以前と同様に起こらない。

緩和されるのは、禁止5が実際に守ろうとしている結果そのものではなく、**その結果を保証するために使っていた古い代理指標**（「重畳区間全体が両者とも無歌唱でなければならない」という全体窓ベースの判定）だけである。stem で歌と伴奏が独立して鳴らせる以上、この代理指標はもはや必要条件ではない。

### 禁止3「MixStream に解析ロジックを入れない」は維持

`mixStream.js` の `#readStemCrossfadeFrame()` は `gainForStemPosition()`（純粋な算術）と `mixNFrames()`（純粋なミキシング）しか呼ばない。歌がいつ終わる/始まるかの判断はすべて Planner 層（`stemTransition.js` の `buildStemEnvelopes()`）が行い、`plan.stems` という事前計算済みの数値としてのみ Execution 層に渡す。

### 禁止4「解析完了待ちで realtime playback を止めない」は維持

stem-mix は `getCachedStems()`（ファイルシステムの存在チェックのみ、ミリ秒未満）が両側ともヒットしたときにしか試行しない。ヒットしなければ Phase 7 の既存フォールバック階梯（beatmix → phrase-crossfade → legacy crossfade/tail-fade/simple-fade/gapless）がそのまま動く。Demucs 分離自体は `#scheduleAnalysis()` の中でバックグラウンド実行され、crossfade の判定はそれを一切待たない。

---

## 3. Step 8.1 — 永続 stem キャッシュ

`src/audio/stemCache.js`。この repo の既存 temp ファイル運用（`normalize.js` の `TEMP_DIR`、`vocalActivity.js` の per-call `mkdtemp`）はすべて「呼び出しが終わったら即削除」だが、Demucs のフルトラック分離は再計算コストが高いため、意図的に**呼び出しをまたいで永続化**する初の temp-audio キャッシュになる。

- キーは `videoId`。1 エントリ = `<STEM_CACHE_DIR>/<videoId>/{vocal.wav, instrumental.wav, meta.json}`
- `meta.json` に `demucsModel` を記録し、モデルが変わった既存エントリは無効化する
- 入力は必ず `input.wav` という決め打ちの名前でカットしてから Demucs に渡す（`vocalActivity.js` の `combined.wav` と同じ発想）。ダウンロード済みファイル（`normalize.js` の `tempFilePath()`）は拡張子を持たないため、Demucs 自身の basename 由来のサブディレクトリ命名に依存すると何が生成されるか読みにくい — 入力ファイル名を固定することでこの曖昧さ自体を回避している
- Bot process は SQLite を開かない（CLAUDE.md）。キャッシュのメンバーシップは `meta.json` サイドカーのみで管理し、新しい DB テーブルは追加しない

### 完了条件

- `getCachedStems(videoId)` は分離済みなら `{vocalPath, instrumentalPath}`、未分離/モデル不一致なら `null` を返す
- `separateTrackStems()` は同じ `videoId` への同時呼び出しをデデュープし、Demucs を二重実行しない
- `pruneStemCache({maxBytes})` は mtime の古い順に、合計サイズが `maxBytes` を下回るまでエントリごと削除する。`normalize.js` の `cleanupStaleTempDir()` と違い、起動のたびに全消去はしない

---

## 4. Step 8.2 — フレーム合成のN本化

`src/audio/fade.js`。

- `mixFrames(outFrame, inFrame, outGain, inGain)` を N 本対応の `mixNFrames(frames, gains)` に一般化し、`mixFrames` はその薄いラッパーにする（n=2 のときバイト単位で従来と同一になることを、テストではなく実装の構造そのもので保証する）
- N>2 のヘッドルームは `OVERLAP_GAIN * (2/n)`。実測での検証はできていない（§21）
- `gainForStemPosition()` を新規追加。1 つの stem のフェード窓が、外側のクロスフェード区間の**遅延した部分区間**になりうる（`inVocal` が `outVocal` の消音を待ってから開始する、など）ケースに対応する。`startOffsetSec=0` かつ自分の `fadeSec` が外側の `fadeSec` と一致するときは `gainForPosition()` と完全に同じ値を返す（`outInstrumental`/`inInstrumental` のケース）

---

## 5. Step 8.3 — vocal-safety 緩和フラグ

`src/audio/beatmixTransition.js` の既存関数にオプションを追加する形で実装し、新しいロジックを並行して書き直すことはしない（Phase 7C の約 165 行のテンポ/ダウンビート/拍数フィッティングを重複させないため）。

- `findExitCandidates(outgoing, { requireVocalSafe = true })`: `false` で `lastVocalEndSec` フィルタを外す。`hasVocalAnalysis()` のゲートはそのまま残す（歌がいつ終わるか実際に分かっていない場合、フィルタを外しても提供できる情報がない）
- `scoreTransitionPair({ ..., stemAware = false })`: `true` のとき `vocalSafety` から exit-margin 項を除外する（entry-margin 項は残す — §1.1 のスコープカット）
- `planBeatmixTransition(outgoing, incoming, { requireExitVocalSafe = true, requireEntryForwardSafe = true, stemAware = false })`: 上記 2 つと、重畳区間ぶんの entry 側前方無歌唱チェックへ配線する。3 つとも既定値は Phase 7 と完全に同じ挙動を保つ

`src/audio/stemTransition.js`: `planStemTransition()` は `planBeatmixTransition()` を上記フラグを緩めて1回呼ぶだけの薄いラッパー。`buildStemEnvelopes()` が `plan.stems`（`outVocal`/`outInstrumental`/`inInstrumental`/`inVocal` の 4 つのゲイン包絡記述）を追加する。

### 完了条件

- `beatmixTransition.test.js` の既存テストがフラグ追加後も1件も変わらず通過する（デフォルト値の後方互換性）
- 出る曲の退出点が歌の途中にあるフィクスチャで、`planBeatmixTransition()` は却下し `planStemTransition()` は受理することをテストで示す

---

## 6. Step 8.4 — MixStream の stem crossfade

`src/audio/mixStream.js` に `startStemCrossfade()` を追加する。`#current`/`#incoming` という 2 ソース固定の構造そのものは変えない — stem ミキシングは **重畳区間の間だけ** 有効な、並行する別の読み取りパスとして実装する。

- `startStemCrossfade({outgoing:{vocal,instrumental}, incoming:{vocal,instrumental,full}}, plan)`。`incoming.full` は通常のクロスフェードが使うのと同じ、フルミックス継続用のソース
- 重畳区間中は `outgoing.vocal`/`outgoing.instrumental`/`incoming.vocal`/`incoming.instrumental` の 4 本だけを読んでミキシングし、`incoming.full` は**同じティックで読み捨てるだけ**（音声としては使わない）。これは重要な設計判断で、`incoming.full` を単に開いたまま放置すると `PcmSource` のバックプレッシャ上限（約2秒分のバッファ）で ffmpeg 側の実デコード位置が止まってしまい、重畳が2秒を超えた時点で昇格後の再生位置が巻き戻る。読み捨てを stem と同じケイデンスで続けることで、昇格の瞬間に `incoming.full` が正しい継続位置に自然と揃う
- ベーススワップ EQ は **伴奏 stem のみ** に適用する。低域成分はほぼ伴奏側にしか無く、ボーカル stem をフィルタするのは無意味かそれ以上に悪い。合算後にフィルタをかけると、ボーカルと伴奏をそもそも分離した意味が失われる
- 4 本のうち 1 本が重畳完了前に予期せず終了/エラーした場合、そのスロットだけ**無音で代用**して残りのミキシングを続ける（stem ソースはローカルの分離済み WAV を読むだけなので、ネットワーク由来のストリームと違って途中で詰まるより spawn 時点で失敗する方が典型的 — その失敗は `startStemCrossfade()` 呼び出し前の事前チェックで弾く）

### 完了条件

- 合成後の値が envelope の想定通りに動くことをテストで示す（特に `inVocal` の開始オフセット前は、その stem の内容を変えても出力が一切変わらないこと）
- 1 stem が早期終了しても遷移全体が完走し、`trackend {promoted:true}` が発火すること

---

## 7. Step 8.5 — player.js の配線

- `#scheduleAnalysis()` の**既存の**キューイング済みジョブの中に、解析完了後の処理として `separateTrackStems()` を連結する。ファイルが確実にまだ存在している場所はここだけであり、独立した fire-and-forget 呼び出しは既存の temp file クリーンアップ経路と競合しうる
- 出る側の stem 準備（`#ensureOutgoingStemPrep()`）は曲の再生開始時ではなく、**`#maybeStartCrossfade()` の `prepDue` ゲート内**で退出点にシークして遅延生成する。曲の再生開始時に `startSec:0` で開いて数分間放置すると、既存の incoming.full と同じバックプレッシャ問題が発生する
- `#maybeStartCrossfade()` は `planBeatSyncedTransition()` の結果が `'beatmix'` を勝ち取らなかった場合にのみ（`stemAware` はテンポ/ダウンビートの要件を一切緩めないため、beatmix が既に成功していれば stem-mix に改善の余地はない）、両側の stem キャッシュ有無を確認したうえで `planStemTransition()` を独立に試す。成功すれば既存の `norm`/`mixPlan` を丸ごと置き換える

### 完了条件

- 両側の stem がキャッシュ済みかつ出る側が歌の途中で退出するフィクスチャで、stem-mix が選ばれ4本の stem ソースが正しいパスで生成されることをテストで示す
- キャッシュが無い場合、stem ソースが一切生成されず、既存の階梯がそのまま動くことをテストで示す

---

## 8. Phase 8 完了条件（全体）

- `npm run test:server` が全通過し、既存の Phase 6/7 テストが1件も変わらず通過する（後方互換性）
- `npm run typecheck` が通る（Bot process 側の JS ファイルは対象外 — Phase 7 以前と同じ）
- ステム分離が完全に失敗しても（キャッシュ未ヒット）、既存の Phase 7 フォールバック階梯だけで従来通り動作する

---

## 9. 未決事項（仮値）

- フルトラック Demucs の CPU コスト: 未計測。Phase 7A 以来のこの環境の制約として、実音源を使った計測はこのエージェント環境では行えない
- `mixNFrames()` の N=3/4 ヘッドルームスケーリング（`OVERLAP_GAIN * (2/n)`）: 保守的に選んだ値だが、実音源での相関を伴う信号加算に対する検証はできていない
- `vocalCrossoverMarginSec`（既定 0.2 秒）: 仮値
- stem キャッシュのサイズ上限（`DEFAULT_STEM_CACHE_MAX_BYTES`、既定 2GB）: 仮値
- `getAnalysisQueue()` はプロセス全体で単一のシリアルキュー。フルトラック Demucs（従来の75秒クリップ固定より重い）を同じキューに通すと、あるギルドの stem 分離が別ギルドの遷移計画をブロックしうる。専用の別キューに分離するか、対象トラック長に上限を設けるかは未決
- `#ensureAnalysisPrefetch()`（2〜3 曲先の先読み）へは意図的に配線していない。まだ確定していない遷移候補に対してフルトラック Demucs を走らせるのは不釣り合いという判断
- Demucs の実出力ディレクトリ命名規則（決め打ちの `input.wav` → `<model>/input/` を仮定）は、実際の Demucs バイナリに対して検証できていない
- `MAX_STEM_CATCHUP_HOLD_TICKS` での強制 promotion（Codex, PR #39）: `#incoming`（継続用フルミックス）が恒常的な CPU 逼迫等で 1 tick あたり最大 1 フレームしか供給できない場合、既存の欠損 D フレームは縮まらず、50 tick のキャップに達すると D フレーム分ずれたまま promotion される。position のブックキーピング（`#consumedBytes`）自体は実際に読めたフレーム数から正しく算出するよう修正済みだが、`#incoming` の実際の再生内容が D フレーム分過去を指している（最大 1 秒弱のリプレイ）問題自体は未解決。真の修正には `#incoming` を promotion 時点でシークし直す（`PcmSource` に現在位置を問い合わせる/再シークする API が必要）か、キャップ到達時点で継続を諦めて `sourceerror` 経由の通常リカバリに委ねるかの判断が要る。継続的な CPU 逼迫時のみ発生する稀な劣化として、このラウンドでは対応を見送った
- `#readStemCatchingUp()` の per-stem 追いつき（4 stem + `#current` フォールバック共通、Codex, PR #39）: この関数は「同一 tick 内で既にバッファ済みの追加フレームを 1 枚ドレインする」ことでしか deficit を縮められない。ストールから復帰した stem が以後ちょうど 1 tick あたり 1 フレームのペースでしか供給されない（バーストが一切発生しない）場合、追加ドレインが常に空振りするため deficit は復帰時点の値のまま — 増え続けはしない（ストール中しか `deficit+1` は起きない）が、当該 stem はウィンドウ残り全体で他 3 本より固定 tick 数遅れた内容を鳴らし続ける。真の解決には (a) 他 3 stem を意図的に足踏みさせて遅れた stem に追いつかせる、(b) 遅れた stem の再生速度を一時的に上げる、(c) 該当 stem だけ諦めて `startStemCrossfade()` 開始時点の設計判断（round 8-9 で 2 回却下された「ウィンドウ途中でのモード切替」）を再訪する、のいずれかが要り、いずれも実音声での聴感検証なしに実装するのはリスクが高いと判断し見送った。実運用の decoder（ffmpeg 経由）が真に「バーストゼロで正確に 1 tick = 1 frame」という条件を継続的に満たすのは稀なケースである点も踏まえた判断
