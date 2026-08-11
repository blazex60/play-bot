# MIX プレイリスト機能 実装プラン

対象リポジトリ: `blazex60/play-bot`

---

## 1. 目的

以下の3機能を追加する。

| 機能 | 内容 |
|---|---|
| 自然なクロスフェード | 曲の性質に応じて重畳長を変えながら曲間を繋ぐ |
| 曲順の最適化 | キュー内の曲順を Gemini で並べ替える |
| リクエストに応じた自動プレイリスト作成 | ユーザーのリクエスト文からプレイリストを生成する |

---

## 2. 決定事項

| 論点 | 決定 |
|---|---|
| クロスフェードの実現方式 | 連続 PCM ミキサーへの再設計（ffmpeg `acrossfade` による簡易実装は不採用） |
| ミキサーの適用範囲 | 全再生経路をミキサーに統一する。移行期間中のみ `MIXER_ENABLED` フラグで旧経路を残す |
| 「LLM・外部 AI API 不使用」の設計方針 | 撤回する。Gemini を採用する |
| 既存 `autoplay.js` との関係 | 置き換えず、MIX は別機能として併存させる |
| normalize との関係 | MIX（クロスフェード）時は normalize を強制 ON にする |
| クロスフェード長 | 固定値ではなく、曲末の解析結果から曲ごとに自動決定する |

### 未決だった項目のデフォルト

| 項目 | 採用値 |
|---|---|
| スラッシュコマンド | `/mix order`（曲順最適化）、`/mix create`（自動生成） |
| Gemini モデル | `gemini-2.5-pro`（`.env` の `GEMINI_MODEL` で上書き可）。キー未設定時は機能を無効化して再生を止めない |
| 曲末解析キャッシュ | migration `006` で新テーブル `track_analysis`（`video_id` PK） |
| 連続 underrun 許容 | 初期値 **8 秒**（定数化して実測後に調整） |
| RMS 包絡取得 | Phase 2 着手時に loudnorm 同一パス検証。不可なら **2 パス**（loudnorm + `astats`/`silencedetect`）に落とす |

---

## 3. なぜ再設計が必要か

現在の `GuildPlayer` は「1曲 = 1 AudioResource」で、`AudioPlayerStatus.Idle` を受けてから次曲の resource を組み立てる（`src/player.js` の `#handleAfter`）。`@discordjs/voice` の AudioPlayer は同時に1つの resource しか再生できないため、**前の曲の終端と次の曲の先頭が重なる区間を作れない**。

したがってクロスフェードには、

- セッション中ずっと生きる単一の `Readable` を `StreamType.Raw` で1度だけ resource 化し、
- その中に自前のミキサーが PCM フレームを書き込み、
- 曲送りを Idle イベントではなくミキサーが駆動する

という構造が必要になる。

### コスト面の前提

「ミキサーを挟むと ffmpeg が1本増える」は**成立しない**。現行の非 normalize 経路は `StreamType.Arbitrary` のため、`@discordjs/voice` が内部で prism-media 経由の ffmpeg トランスコーダを起動している。自前で ffmpeg → s16le に変換すれば `StreamType.Raw` になり、voice 側の内部トランスコードが不要になる。プロセス本数は変わらず、CPU コストはほぼ中立。

JS 側のサンプル加算も、1曲だけ流れている間は加算せずバッファをそのまま push する最適化が可能。実コストが乗るのはクロスフェード中のみ。

---

## 4. 目標アーキテクチャ

### 4.1 新規モジュール

| モジュール | 役割 |
|---|---|
| `src/audio/pcmSource.js` | 1曲 = 1 PCM ソース。ffmpeg を s16le/48000/2ch で吐かせる |
| `src/audio/mixStream.js` | `Readable` 派生。20ms = 3840 バイトのフレームを生成し、`current` と `incoming` を加算して push |
| `src/audio/fade.js` | フェードカーブとゲイン計算。純粋関数 |
| `src/audio/trackAnalysis.js` | 曲末の形状解析と推奨クロスフェード長の算出（Phase 2） |
| `src/web/server/services/gemini.js` | Gemini API クライアント（Phase 3） |

### 4.2 GuildPlayer の変更

- コンストラクタで MixStream を1回だけ resource 化して `play()`。以降 AudioPlayer は Playing 固定
- `playNext()` → `#loadSource(track)`（normalize prefetch → PcmSource 生成 → `mix.setCurrent()`）
- `trackend` イベントが従来の `#handleAfter` を駆動
- `skip()` は `mix.dropCurrent()`
- `AudioPlayerStatus.Idle` が発火したら**異常**として扱う

### 4.3 必須ガード

underrun 時に無音フレームを push する設計のため、連続 underrun が **8 秒**続いたら強制的にエラー扱いにする。

---

## 5. 自然なクロスフェードの要件

1. 曲末の実際の音楽終端を取る（`silencedetect` + RMS 包絡）
2. ラウドネスを揃える（normalize 強制 ON）
3. クリップ対策（重畳区間に -3dB マージン or ソフトリミッタ）
4. 形状別フェード長: 単調減衰 1–2s / ぶつ切り 4–6s / 無音・拍手は音楽終端前倒し。上限は曲長 10%

---

## 6. Gemini の配置

Web process 側（`src/web/server/services/gemini.js`）一択。`webClient.js` 経由で `optimizeOrder` / `generatePlaylist`。

防御: タイムアウト・リトライ・レート制限、失敗時は `null`、zod 検証、曲順は入力の順列であることを検証。

---

## 7. フェーズ

### Phase 0 — 等価性の物差し ✅ 進行中

- Idle 非依存の受け入れテストを `src/player.acceptance.test.js` に切り出し
- `MIXER_ENABLED`（デフォルト false）を `.env.example` に追加
- 成果物: 新旧どちらの実装でも通るべきテスト一覧（本ファイル + テストファイル）

#### 受け入れテスト一覧（`src/player.acceptance.test.js`）

| カテゴリ | 内容 |
|---|---|
| 再生ポリシー | `isShortTrack` / `shouldReconnectRetry` の単体検証 |
| エラー時 advance | 再生不能曲の自動スキップ、`forceAdvance` による TRACK ループ脱出 |
| ハンドオフ競合 | ハンドオフ中のエラーが1回だけ advance される |
| キュー枯渇 | `handleQueueExhausted` true/false/throw の3パターン |
| ループ | QUEUE ループで先頭に戻る |
| 短尺曲 | 5秒未満の曲は再接続リトライしない |
| 記録 | `recordPlay` / `onTrackStart` の有無と失敗耐性 |

### Phase 1 — PCM ミキサー基盤（クロスフェード0秒）

### Phase 2 — クロスフェード

### Phase 3 — Gemini 導入 + 曲順最適化（着手前に Phase 5 法務）

### Phase 4 — リクエストからの自動プレイリスト生成

### Phase 5 — ドキュメントと法務

---

## 8. 依存関係

```
Phase 0 → Phase 1 ─┬→ Phase 2
                   └→ Phase 5(法務) → Phase 3 → Phase 4
```

Phase 1 完了後に本番投入を1回挟む。
