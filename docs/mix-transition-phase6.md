# MIX つなぎ品質向上プラン（Phase 6）

対象リポジトリ: `blazex60/play-bot`
配置先: `docs/mix-transition-phase6.md`
前提文書: [`docs/mix-plan.md`](mix-plan.md) / [`docs/mix-analysis-spike.md`](mix-analysis-spike.md)

---

## 0. この文書の使い方

`mix-plan.md` と同じ運用。各 Step の「完了条件」を受け入れ基準として使う。
未決事項の閾値は仮値のまま実装し、実機キャリブレーションは完了条件に残す。

---

## 1. 背景 — 現状診断

実機の症状は「**歌と歌が重なる**」「**ぶつ切りで切り替わる**」の2点。
原因はどちらも同じで、**Phase 2/3 で実装した解析が本番で一度も効いていない**ことにある。

### 1.1 confidence が構造的に上限に張り付いている

`trackAnalysis.js` の現行式（Phase 6 以前）:

```js
const vocalConfidence = 0.2;              // ハードコード
const confidence = Math.min(
  tail.ok ? 0.8 : 0.3,
  0.4 + bpmConfidence * 0.3,
  0.35 + vocalConfidence,                 // → 上限 0.55
);
```

- `vocalConfidence` が 0.2 固定のため、**confidence は理論上も 0.55 を超えられない**
- `Dockerfile` は aubio 無し → `bpmConfidence = 0` → `confidence = 0.4`
- `transition.js` の `conf < 0.55` 分岐に必ず落ち、`mode: 'simple-fade'` / `fadeSec ≤ 1.5` / `baseSwap: false` に固定される

結果として、実装済みの `eq.js`（ベーススワップ）、`recommendOverlapSec` の曲別可変長、BPM がすべて死んでいる。

### 1.2 症状との対応

- **ぶつ切りで切り替わる**: `abrupt` な曲末には `recommendOverlapSec` が 5 秒を返すが、simple-fade 分岐が 1.5 秒に上書きし低域も渡さない
- **歌と歌が重なる**: 繋ぎ位置が「残り fadeSec の地点」という時間だけで決まり、そこに歌が乗っているかを見ていない

### 1.3 曲順最適化も同じ理由で無効化されている

`ordering.js` の `transitionCost` は `bpm` と `harmonicConfidence >= 0.55` を前提とするが、本番では `bpm = null` / `harmonicConfidence = 0` / `headKey`・`tailKey` = null。
全ペアが `MISSING_ANALYSIS_PENALTY` で同点になり、経路探索が意味を持っていない。

---

## 2. 決定事項

- 目標: つなぎの自然さ + 選曲/曲順の文脈性。**DJ の音声 MC（TTS）は対象外**
- ボーカル区間検出: **音源分離（Demucs）を採用**。essentia のピッチ系ヒューリスティックは不採用
- Demucs の実行場所: Bot と同じコンテナ。`nice` + 1 スレッドで抑える
- ベースイメージ: runtime のみ `node:22-bookworm-slim`（web-build は alpine のまま）
- 解析の先読み: 次の 2〜3 曲先まで前倒し
- 分離の対象範囲: 曲全体ではなく**末尾 45 秒のみ**
- 入り側（incoming）の分離: **不要**

## 2.1 実装時の必須ガード

1. `#maybeStartCrossfade` は Demucs を待たない。arm はメモリ/DB キャッシュのみ読み、未完了なら `simple-fade`
2. 拍スナップは歌のない窓の内側だけ。前倒し（開始を早めて歌に食い込む）は禁止
3. `tail-fade` は非重畳（出る曲を落としてから入る曲を頭出し）
4. BPM は mix 窓（出る曲は末尾、入る曲は先頭）で取る
5. Demucs は venv + `TORCH_HOME` 焼き込み。yt-dlp と torch を混ぜない
6. essentia.js はベストエフォート。キーが取れなくてもボーカル経路は出荷する

---

## 3. Demucs 導入の必須ガード

### 3.1 曲全体を分離しない — 末尾 45 秒だけ

- `--two-stems=vocals` で 2 stem のみ
- `ffmpeg -ss` で末尾 45 秒を切り出してから分離

### 3.2 CPU 競合で mixer が underrun する

- `OMP_NUM_THREADS=1` / `MKL_NUM_THREADS=1` を子プロセス env に設定
- `nice -n 15` で起動
- 解析ジョブは同時実行 1 本のキューに直列化
- MixStream の連続 underrun が 150ms を超えたらジョブを `SIGSTOP`、回復後に `SIGCONT`
- 3 回 pause しても underrun が続く、または停止 2 秒超なら kill して解析なしフォールバック

### 3.3 イメージサイズと初回起動

- torch は CPU 版を明示（`--index-url https://download.pytorch.org/whl/cpu`）
- モデル重みをビルド時に `TORCH_HOME=/opt/torch-cache` へ焼き込む

---

## 4. フォールバック階梯

- 解析あり・末尾に無歌唱窓あり: `crossfade`（baseSwap + 可能なら拍スナップ）
- 解析あり・最後まで歌っている: `tail-fade`（重畳せず 0.5〜0.8 秒でフェード）
- 解析が間に合わない: `simple-fade`（≤1.5 秒）
- ソース生成失敗など: `gapless`

歌に食い込むときは `fadeSec` を縮めて終端に寄せるのではなく、**重畳の開始点を `lastVocalEndSec` 以降に置く**。

---

## 5. 完了条件（Phase 6 全体）

- 実機で 10 曲連続再生し、歌と歌が重なる箇所が 0
- ぶつ切り曲（`abrupt`）で重畳が 3 秒以上取れ、低域の受け渡しが聴き取れる
- Demucs 実行中に underrun が発生しても SIGSTOP で回復し、無音が 1 秒を超えない
- `ordering.js` の `transitionCost` が実 BPM・実キーで計算され、同点になっていない
- 既存の受け入れテスト（`player.acceptance.test.js`）が全通過
- Node テストは Demucs 実バイナリなしでも通る

---

## 6. 未決事項（仮値）

- ボーカル判定の閾値（相対 25dB / 絶対 -50dB）: 仮値。J-POP 実曲で再キャリブレーション
- 末尾窓 45 秒: 仮値
- Demucs モデル: まず `htdemucs`
- 先読み 2〜3 曲時の一時ファイル: フルファイルは現在曲 + 次の 1 曲、解析クリップ上限 4
- `tail-fade` の長さ: 0.6 秒
- SIGSTOP 発動: 連続 underrun 150ms（既存 8 秒ガードより先に解析が退く）
