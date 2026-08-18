# MIX Phase 1.5 — Analysis Spike Results

Validated findings committed: 2026-08-11  
Runner-owned checks: `node scripts/mix-analysis-spike.mjs`（center vocal / tail RMS / combined ffmpeg / aubiotrack）  
Essentia BPM・キー: 別途の one-off Node セッション（`essentia.js` を `--no-save` で導入して計測。runner には含めない）  
Artifacts: `tmp/mix-spike/`（gitignore。runner 再実行は `tmp/mix-spike/report.generated.md` と `results.json` のみ更新し、本ファイルは上書きしない）

## 環境制約

- YouTube は bot 判定で `yt-dlp` ダウンロード不可（この Cloud 環境）
- 代わりに **Archive.org / Incompetech / Wikimedia** の公開 CC・ロイヤリティフリー音源 + 合成コントロールを使用
- `aubio-tools`（`aubiotrack`）は apt で導入可能。Python `aubio` ラッパは NumPy 2 と非互換のため不使用
- `essentia.js` は `bun install` で動作確認（本スパイクでは `--no-save`。本番採用時に `package.json` へ追加）

## サンプル

| id | 期待 | ソース |
|---|---|---|
| vocal-indie-1 | ボーカルあり | Archive.org `ifindmyself.mp3` |
| vocal-indie-2 | ボーカルあり | Archive.org `whatsheknows.mp3` |
| vocal-classical-1 | ボーカルあり | Wikimedia Dvořák Biblical Songs |
| instrumental-carefree | インスト | Kevin MacLeod *Carefree* |
| instrumental-wallpaper | インスト | Kevin MacLeod *Wallpaper* |
| synth-center-vocal | センター帯域トーン | ffmpeg 合成 |
| synth-side-only | サイドのみノイズ | ffmpeg 合成 |

> 注: 本スパイクの実音源は英語 indie / クラシック / インストで、J-POP そのものではない。手法の可否判定用。J-POP 実曲での再キャリブレーションは Phase 2 着手時に追加する。

## 計測結果サマリ

### A. センター成分（mid/side, 200Hz–4kHz）

| id | centerBias dB | vocalLikely (>3dB) | 判定 |
|---|---:|---|---|
| vocal-indie-1 | （side=-inf / 欠測） | — | 失敗（ほぼモノラル寄り） |
| vocal-indie-2 | （side 欠測） | — | 失敗 |
| vocal-classical-1 | **-2.88** | false | 偽陰性 |
| instrumental-carefree | 1.91 | false | OK |
| instrumental-wallpaper | **5.17** | true | **偽陽性** |
| synth-center-vocal | **21.28** | true | OK（コントロール） |
| synth-side-only | side のみ / mid 欠測 | — | コントロール境界 |

**結論（A）: センター成分推定は単体採用しない。**  
合成では効くが、実楽曲では偽陽性・偽陰性・モノラル欠測が混在。J-POP の主制約（歌の重なり回避）には信頼不足。次候補は essentia のピッチ/メロディ系ヒューリスティック、それでも不足なら Demucs（Docker 変更を伴う最終手段）。

### B. BPM（aubiotrack vs essentia.js）

| id | aubiotrack BPM（runner） | essentia RhythmExtractor2013（manual） | PercivalBpmEstimator（manual） | 所要 |
|---|---:|---:|---:|---|
| vocal-indie-1 | 147.5 | 146.4 (conf 0.10) | **80.1**（半テンポ疑い） | aubio ~0.3s / essentia ~5.5s / 60s |
| instrumental-carefree | 97.1 | 96.0 (conf 3.65) | 96.1 | 同上 |
| instrumental-wallpaper | 93.9 | 93.0 (conf 4.15) | 93.1 | 同上 |

**結論（B）: BPM は `aubiotrack` を第一候補、キーも要る解析パスでは `essentia.js` を併用。**  
半テンポ/倍テンポは RhythmExtractor と Percival の不一致で検出し、信頼度を落とす。

### C. キー（essentia KeyExtractor・manual）

| id | key | scale | strength |
|---|---|---|---:|
| vocal-indie-1 | C | major | 0.58 |
| instrumental-carefree | F | major | 0.93 |
| instrumental-wallpaper | G | major | 0.98 |

> essentia の表は runner 出力ではない。再現時は別セッションで KeyExtractor / RhythmExtractor2013 を呼ぶこと。

**結論（C）: `essentia.js` KeyExtractor を採用方針とする。**  
`headKey` / `tailKey` は曲頭・曲末の窓を別々にかけて推定。strength < 0.55 程度は低信頼としてハーモニック判定をスキップ（閾値は Phase 2 で再調整）。

### D. ffmpeg 解析パス数

末尾 30 秒に対し  
`loudnorm=...:print_format=json,silencedetect=...,astats=metadata=1:reset=0.1`  
を **1 回の ffmpeg 呼び出し**で実行 → 全実サンプルで `loudnorm JSON=true`、所要 ~1.0s。

**結論（D）: loudnorm + silencedetect + 尾部 RMS は 1-pass で採用。**  
ボーカル/BPM/キーは別パス（aubio / essentia）。

### E. 信頼度（暫定）

低信頼 → 単純フェードへ落とす条件（仮）:

1. BPM: RhythmExtractor と Percival が 1.8〜2.2 倍関係、または conf が極端に低い
2. Key: strength < 0.55
3. Vocal gate: センター成分は使わない。メロディ信頼が取れない間は **重畳長を短く上限クランプ（≤2s）** して歌被りリスクを下げる
4. normalize 不可（>1800s）は従来どおりクロスフェード対象外

## 採用決定（Phase 2 入力）

| 項目 | 決定 |
|---|---|
| ボーカル検出 | **センター成分は不採用（単体）**。Phase 2 初期は短重畳＋ベーススワップでリスク緩和。並行して PitchMelodia 系ヒューリスティックを評価。Demucs は Dom 変更が必要なため保留 |
| BPM | **aubiotrack 第一**。essentia はキー解析と同梱時にクロスチェック |
| キー | **essentia.js KeyExtractor**（head/tail 窓） |
| ffmpeg パス | loudnorm+silence+tail RMS は **1-pass**。BPM/キーは別 |
| 信頼度 | 上記 E の暫定閾値。実 J-POP で再キャリブレーション |
| Docker | Phase 2 で `aubio`（apk/apt）と `essentia.js`（npm）を追加。Python 音源分離はまだ入れない |

## 未解決 / 次アクション

- [ ] 実 J-POP 数曲での再計測（本番ホスト or Cookie 付き yt-dlp）
- [ ] essentia PitchMelodia による「歌らしさ」スコアの可否
- [ ] Alpine Docker への `aubio` パッケージ有無確認
- [ ] `headKey`/`tailKey` 窓長（例: 頭15s / 尾20s）の決定

## 再現手順

```bash
# optional: sudo apt-get install -y aubio-tools
node scripts/mix-analysis-spike.mjs
# → tmp/mix-spike/results.json
# → tmp/mix-spike/report.generated.md  （docs/mix-analysis-spike.md は上書きしない）
```

検証済みの結論・essentia 表は本ファイル（committed）を正とする。runner の生成物で置き換えないこと。
