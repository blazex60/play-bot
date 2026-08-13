# MIX プレイリスト機能 実装プラン

対象リポジトリ: `blazex60/play-bot`
配置先: `docs/mix-plan.md`
実装環境: Claude Code / Cursor

---

## 0. この文書の使い方

各 Phase の「完了条件」は、コーディングエージェントに渡す際の受け入れ基準として使う。
未決事項（12章）に残っている項目は、**推測で埋めずに必ず確認すること**。

---

## 1. 目的

| 機能 | 内容 |
|---|---|
| 自然なクロスフェード | DJ 的な「つなぎ目を感じない」接続を目指す |
| 曲順の最適化 | BPM・キー・エネルギーの隣接コストを最小化する経路探索 |
| 自動プレイリスト作成 | ユーザーのリクエスト文からプレイリストを生成する |

---

## 2. 決定事項

| 論点 | 決定 |
|---|---|
| クロスフェードの実現方式 | 連続 PCM ミキサーへの再設計（ffmpeg `acrossfade` は不採用） |
| ミキサーの適用範囲 | 全再生経路をミキサーに統一する。移行期間中のみ `MIXER_ENABLED` フラグで旧経路を残す |
| 「LLM・外部 AI API 不使用」の設計方針 | 撤回する。Gemini を採用する |
| 既存 `autoplay.js` との関係 | 置き換えず、MIX は別機能として併存させる |
| normalize との関係 | MIX 時は normalize を強制 ON にする |
| クロスフェード長 | 固定値ではなく、曲末の解析結果から曲ごとに自動決定する |
| つなぎの目標水準 | ベーススワップ・フレーズ整列/位相合わせ・テンポ合わせ・ハーモニックミキシングまで狙う |
| 主な対象ジャンル | **J-POP / ボーカル中心** |
| 曲順最適化の主体 | BPM/キーの経路探索が主。Gemini は補助（雰囲気・選曲の妥当性） |

---

## 3. なぜ再設計が必要か

現在の `GuildPlayer` は「1曲 = 1 AudioResource」で、`AudioPlayerStatus.Idle` を受けてから次曲の resource を組み立てる（`src/player.js` の `#handleAfter`）。`@discordjs/voice` の AudioPlayer は同時に1つの resource しか再生できないため、**前の曲の終端と次の曲の先頭が重なる区間を作れない**。

したがって、セッション中ずっと生きる単一の `Readable` を `StreamType.Raw` で1度だけ resource 化し、その中に自前のミキサーが PCM フレームを書き込み、曲送りを Idle ではなくミキサーが駆動する構造が必要になる。

### コスト面の前提

「ミキサーを挟むと ffmpeg が1本増える」は**成立しない**。現行の非 normalize 経路は `StreamType.Arbitrary` のため、`@discordjs/voice` が内部で prism-media 経由の ffmpeg トランスコーダを起動している。自前で s16le に変換すれば `StreamType.Raw` になり、voice 側の内部トランスコードが不要になる。プロセス本数は変わらず、CPU コストはほぼ中立。

JS 側のサンプル加算も、1曲だけ流れている間は加算せずバッファをそのまま push する最適化が可能。実コストが乗るのは重畳区間のみ。

---

## 4. 目標アーキテクチャ

### 4.1 モジュール一覧

| モジュール | 役割 | Phase |
|---|---|---|
| `src/audio/pcmSource.js` | 1曲 = 1 PCM ソース。`read(bytes)` / `available` / `ended` / `lastDataAt` / `destroy()` | 1 ✅ |
| `src/audio/mixStream.js` | `Readable` 派生。20ms フレームを生成し `current` と `incoming` を加算 | 1 ✅（重畳は Phase 2） |
| `src/audio/fade.js` | フェードカーブとゲイン計算。純粋関数 | 1(stub) ✅ / 2 |
| `src/audio/eq.js` | biquad（highpass / lowshelf）。ベーススワップ用 | 2 |
| `src/audio/trackAnalysis.js` | ボーカル区間・拍グリッド・キー・曲末形状の解析 | 1.5 / 2 |
| `src/audio/transition.js` | 2曲の解析結果から重畳区間と各種パラメータを決定 | 2 |
| `src/mix/ordering.js` | BPM/キー/エネルギーによる曲順の経路探索 | 3 |
| `src/web/server/services/gemini.js` | Gemini API クライアント | 3 |

### 4.2 PcmSource

- `createFileSource(filePath, { measured })` — DL 済みファイルに loudnorm を適用して s16le/48000/2ch を出力
- `createStreamSource(track)` — yt-dlp stdout → ffmpeg stdin → 同

内部で 1〜2 秒分を先読みバッファし、ffmpeg stdout に backpressure をかける。

### 4.3 MixStream

`_read()` がバックプレッシャーの起点になる。AudioPlayer が 20ms ごとにフレームを引くため、ミキサー側に独自のタイマーは不要。

- `FRAME_BYTES = 3840`（20ms / 48000Hz / 2ch / s16）
- `_read()` で `current` から1フレーム取り出して push。取れなければ pending にし、ソースの `data` で再開
- emit: `trackend` / `underrun` / `sourceerror`
- 曲ごとの再生位置（consumed bytes ÷ 192000）を保持

### 4.4 GuildPlayer の変更（実装済みライフサイクル）

`MIXER_ENABLED=true` 時の実際の流れ:

- コンストラクタで `MixStream` と `#mixerResource`（`StreamType.Raw`）を作るが、この時点では `play()` しない
- `playNext()` → `#playNextMixer()` → `#createPcmSource()` → `mix.setCurrent(source)`。初回だけ `#audioPlayer.play(#mixerResource)` で遅延開始し、以降は Playing 固定を目指す
- `trackend` → `#advanceAfterPlayback()` → `#handleAfter()` が曲送りを駆動
- `skip()` は `mix.dropCurrent()`
- `AudioPlayerStatus.Idle` は異常として扱い、既存の `#mixerResource` を再度 `play()` して復旧する（resource の再生成はしない）

### 4.5 Idle が来なくなることで壊れる箇所

| 箇所 | 影響と対応 |
|---|---|
| watchdog | `playbackDuration` はセッション累計で単調増加し続け、現行のストール検知が永久に発火しない。`source.lastDataAt` と連続 underrun 時間で判定する |
| `/nowplaying` の経過時間 | 同上。MixStream の曲ごと再生位置を使う |
| 曲送り | `trackend` 駆動に変更 |
| `RECONNECT_GRACE`（5秒未満の再試行） | ソース生成失敗の検知に置き換える |
| `#forceSkip` / `#handlingAfter` / `#pendingAfter` | Idle の非同期性に起因する競合処理。mixer 駆動では大幅に整理できる |
| `stop()` / `#onDisconnect` | MixStream を end するか無音を流し続けるかを決める。VC 切断条件も見直す |
| `#tryHandleQueueExhausted` | クロスフェードには次曲が終了前に確定している必要があるため、呼び出しを前倒しする |
| `player.test.js` | Idle 前提のテストはほぼ書き直し |

### 4.6 必須ガード

underrun 時に無音フレームを push する設計のため、**無音のまま永久に再生し続ける状態**が作れてしまう。連続 underrun が一定秒数続いたら強制的にエラー扱いにすること。これを忘れると「Bot は接続しているのに無音」という最もデバッグしづらい障害になる。

---

## 5. J-POP における「自然なつなぎ」の要件

### 5.1 支配的な問題はビートではなく歌

2つのキックが 20ms ずれても「なんとなく変」程度だが、**2人の歌が同時に鳴ると誰でも即座に破綻と分かる**。DJ がボーカル曲を繋ぐときに実際にやっているのは、ビートマッチよりも「歌のない区間で繋ぐ」ことである。

したがって J-POP では、**ボーカル区間の検出が拍検出より優先される**。

### 5.2 J-POP 固有の制約

- **アウトロが短い、または無い。** ぶつ切りで終わる曲、ラスサビ直後に終わる曲が多く、重ねられる窓が 2〜4小節しか取れないことが珍しくない。32小節かけて溶かす EDM 的なミックスは物理的に不可能
- **転調する。** 特にラスサビの半音上げは定番。曲全体を単一キーとして扱う Camelot 判定は信頼できない。`{ headKey, tailKey }` の2つを保持し、前曲の `tailKey` と次曲の `headKey` を突き合わせる

### 5.3 成果物の期待値

**「32小節かけて溶ける DJ ミックス」ではなく、「間奏や無歌唱部で 2〜4小節、低域を渡しながら拍を揃えて重ねる」**という形になる。J-POP でそれ以上をやると不自然になるため、これが正解。

### 5.4 優先順位（ジャンルに合わせて改訂済み）

| 優先 | 項目 | 内容 |
|---|---|---|
| A | **ボーカル区間の検出** | 繋ぎ位置を決める主要制約。新規・最優先 |
| B | **ベーススワップ** | 重畳区間で出ていく曲に highpass（〜120Hz）、入る曲に lowshelf。低コスト高効果 |
| C | **フレーズ整列・位相合わせ** | A で見つけた窓の中で小節境界とキックを揃える。現代 J-POP は DAW 制作で BPM が安定しており拍検出精度は高い。危険なのはバラード・ライブ音源・生演奏 |
| D | **テンポ合わせ** | **優先度低。** 重畳が 2〜4小節なら数%のテンポ差は顕在化しない。長く重ねられる曲に限った贅沢機能。事前レンダリングするためリアルタイム負荷はゼロ |
| E | **ハーモニック判定** | 曲全体ではなく重畳区間のキーを推定（`headKey` / `tailKey`） |

### 5.5 共通の音響処理

- **クリップ対策** — -16 LUFS の2本を加算すると瞬間的に +6dB 近く跳ねる。loudnorm の `TP=-1.5` では足りないため、重畳区間に -3dB マージンを入れるか、ミックス後にソフトリミッタを噛ませる
- **フェードカーブ** — equal-power（`cos`/`sin`）を無相関素材に、linear を同一曲ループに使い分ける

---

## 6. 曲末解析による重畳長の決定

prefetch 時に末尾の RMS 包絡を 100ms 刻みで取得し、形状で分類する。

| 終端の形状 | 重畳長 |
|---|---|
| 単調減衰（フェードアウト済み） | 1〜2 秒 |
| 急に切れる（ぶつ切り） | 4〜6 秒 |
| 無音・拍手が続く | 音楽終端まで前倒しして重ねる |

上限は曲長の 10% 程度でクランプ。ただし 5.1 により、**ボーカル区間と衝突する場合はボーカル側の制約を優先する**。

---

## 7. normalize 強制 ON の帰結

- `MAX_NORMALIZE_DURATION_SEC = 1800` があるため、**30分超の曲はクロスフェード対象外**。仕様として `/help` とドキュメントに明記する
- 現行の prefetch は「次の1曲だけ」。解析が重くなるぶん前倒しが必要で、キューが1曲しかない場面では間に合わない。**間に合わない場合は単純フェード、さらに間に合わなければギャップレス接続へ、と二段階でフォールバックする**

---

## 8. 曲順最適化と Gemini

「Bot process は SQLite を開かない」という既存の境界に従い、Gemini クライアントは **Web process 側（`src/web/server/services/gemini.js`）**に置く。Bot は既に `webClient.js` 経由で履歴を取得しているため、同じ経路に追加する。

### 役割分担

解析で BPM・キー・エネルギーが取れるため、**技術的な曲順はアルゴリズムが決める**。

- `src/mix/ordering.js` — 隣接コスト（BPM 差、`tailKey`→`headKey` の Camelot 距離、エネルギー段差）を最小化する経路探索
- Gemini — 雰囲気・文脈・選曲の妥当性の評価、およびリクエスト文からの曲名生成

なお、**BPM の近い曲を隣に置けばテンポ合わせ（D）は不要になる**。曲順最適化と繋ぎは同じ問題の裏表である。

### Gemini 呼び出しの必須の防御

- タイムアウト・リトライ・レート制限を実装し、**失敗時は必ず `null` を返して再生を止めない**
- 出力は zod（既存依存）でスキーマ検証する
- 曲順に関しては、**結果が入力の順列であることを検証**し、違反したら元順序にフォールバックする。LLM は曲を落としたり重複させたりする

---

## 9. フェーズ

### Phase 0 — 等価性の物差しを作る ✅ 完了（PR #19）

- Idle 非依存の受け入れテストを `src/player.acceptance.test.js` に切り出し
- `MIXER_ENABLED`（デフォルト false）を `.env.example` に追加
- `playbackPolicy.js` / `playbackDrive.js`（`triggerTrackEnd`）を追加

### Phase 1 — PCM ミキサー基盤（クロスフェード0秒） ✅ 完了（PR #19）

ギャップレス接続のみ。`MIXER_ENABLED=true` で有効化。

- `pcmSource.js` / `mixStream.js` / `fade.js`（スタブ）
- `player.js` の mixer 駆動パス（`trackend`、Idle 異常復旧、mixer watchdog）
- 連続 underrun ガード（実装値 8s — 12章の実測確認待ち）

**完了条件**: Phase 0 のテスト全通過。実機で 10曲連続再生、skip 連打、stop → 再生、両ループモード、再生失敗曲を含むキューが正常。CPU 使用率が旧経路と同等。

> 注: ユニット/受け入れテストは通過済み。実機 A/B（10曲連続・CPU 比較）は本番投入時の確認項目として残る。

### Phase 1.5 — 解析スパイク（新規・Phase 2 の前提） ✅ 完了（初回）

公開 CC 音源 + 合成コントロールで計測。詳細は [`docs/mix-analysis-spike.md`](mix-analysis-spike.md)。

**採用（暫定）**: BPM=`aubiotrack`、キー=`essentia.js`、loudnorm+silence+tail=ffmpeg 1-pass。  
**不採用**: センター成分のみのボーカル検出。Demucs は保留。  
**残作業**: 実 J-POP での再キャリブレーション、PitchMelodia 評価、Docker への aubio/essentia 追加。

### Phase 2 — クロスフェード本実装 ✅ 完了（PR #21）

Phase 1.5 の結論に従って実装。優先順位は 5.4 の A → B → C → E → D。

実装済み:
- `fade.js` — equal-power/linear、`-3dB` マージン、ソフトリミッタ
- `eq.js` — ベーススワップ用 biquad（highpass / lowshelf）
- `trackAnalysis.js` — 曲末形状 + aubiotrack BPM（キーはキャッシュ列のみ・essentia は次）
- `transition.js` — 二段階フォールバック（crossfade / simple-fade / gapless）とボーカル弱時の ≤2s クランプ
- `mixStream.js` — `startCrossfade` による重畳
- `player.js` — クロスフェード arm、normalize 強制、解析キャッシュ接続
- migration `006_track_analysis.sql` + `/internal/track-analysis/:videoId`

残作業（Phase 2 後追い）: テンポ合わせ(D)。aubio / Demucs / essentia キーは Phase 6

### Phase 3 — 曲順最適化 + Gemini 導入 ✅ 完了（PR #22）

- `src/mix/ordering.js` + `camelot.js` — BPM/キー隣接コストの経路探索
- `src/web/server/services/gemini.js` — 任意の Gemini 補助（失敗時は algorithm のみ）
- `/internal/optimize-order` + `webClient.optimizeOrder`
- `/mix order` + Web ダッシュボード「MIX 並べ替え」

### Phase 4 — リクエストからの自動プレイリスト生成 ✅ 完了（PR #25）

- `src/mix/playlistGenerate.js` — Gemini 曲名提案 → YouTube 解決 → `ordering.js` で並べ替え
- `/internal/generate-playlist` + `POST /api/playlists/mine/generate`
- `/mix create` + Web「Gemini で生成」

### Phase 5 — ドキュメントと法務

- `CLAUDE.md` / `AGENTS.md` / `README.md` の「LLM・外部 AI API は一切使用しない」を削除し、Gemini の利用範囲・送信データ・失敗時挙動の記述に置き換える
- `legal/privacy.html` に Gemini への送信内容（曲名・チャンネル名・リクエスト文）を追記する。Google API 由来データを含むため、Google の Limited Use 要件との整合を確認すること
- 音声アーキテクチャの節を Idle 駆動 → mixer 駆動に全面書き換え
- Phase 1 の安定確認後、`MIXER_ENABLED` フラグと旧経路を削除

### Phase 6 — 曲ごとの DJ つなぎ 🚧

詳細は [`docs/mix-transition-phase6.md`](mix-transition-phase6.md)。

- Demucs（末尾 45 秒・`--two-stems=vocals`）で `lastVocalEndSec` を取り、歌のない窓でのみ `crossfade` + ベーススワップ
- 最後まで歌っている曲は非重畳の `tail-fade`
- runtime イメージを `node:22-bookworm-slim` にし aubio / Demucs venv を同梱
- 解析は直列キュー。arm はキャッシュのみ（Demucs 待ちでクロスフェードを止めない）
- essentia.js キーはベストエフォート

---

## 10. 依存関係

```
Phase 0 → Phase 1 ─┬→ Phase 1.5 → Phase 2 ──┐
                   │                          ├→ Phase 3 → Phase 4
                   └→ Phase 5(法務) ──────────┘
                                      Phase 2 → Phase 6（つなぎ品質）
```

- Phase 1 と Phase 1.5 の間に本番投入を1回挟む
- Phase 1.5 と「法務」は並行できる
- Phase 3 は Phase 2 の解析結果（BPM/キー）に依存する

---

## 11. 制約と限界（合意済み）

- **拍検出は曲を選ぶ。** 4つ打ちの安定した曲では高精度だが、ライブ音源・アコースティック・ルバートのあるバラード・テンポの揺れる曲では外す。倍テンポ / 半テンポ誤検出も起きる
- したがって**全曲を DJ ミックスにはできない**。信頼度が低い曲は単純フェードへ落ちる
- 30分超の曲はクロスフェード対象外（normalize 不可のため）
- 重畳長は J-POP では 2〜4小節程度が上限になることが多い

---

## 12. 未決事項

| 項目 | 状態 |
|---|---|
| ボーカル検出の採用手法 | **Demucs（末尾 45 秒・two-stems）を Phase 6 で採用。** センター成分は不採用 |
| 拍/BPM 検出ライブラリ（aubio / essentia.js） | **aubiotrack 第一**、essentia はキー同梱時にクロスチェック |
| ffmpeg 解析パスを何回にするか | loudnorm+silence+tail は **1-pass**。BPM/キーは別 |
| 検出信頼度の閾値 | 暫定: key strength&lt;0.55、BPM 半/倍不一致 → 単純フェード。実 J-POP で再調整 |
| 音源分離採用時の Docker 構成変更 | Phase 6: runtime を bookworm-slim + Demucs venv |
| スラッシュコマンド名 | `/mix order` / `/mix create` を仮置き |
| 使用する Gemini のモデル名 | 未定（`.env.example` に `gemini-2.5-pro` を仮記載済み。確定前に確認） |
| 解析キャッシュのスキーマ（新テーブル / 既存拡張） | 未定 |
| 連続 underrun の許容秒数 | 実装仮値 8s。実測して決める |

---

## 13. 実装進捗メモ（エージェント追記）

| Phase | 状態 | 備考 |
|---|---|---|
| 0 | ✅ | PR #19 / `src/player.acceptance.test.js` |
| 1 | ✅ | PR #19 / `MIXER_ENABLED` で切替。重畳なし |
| 1.5 | ✅ 初回完了 | `docs/mix-analysis-spike.md`。実 J-POP 再計測は残 |
| 2 | ✅ | PR #21 merged。重畳・解析キャッシュ・二段階フォールバック |
| 3 | ✅ | PR #22。ordering + Gemini refine + `/mix order` |
| 4 | ✅ | PR #25。`/mix create` + Web 生成 |
| 5 法務 | ✅ 文面更新済み | privacy / CLAUDE / AGENTS / README。PR #19/#20 |
| 6 | 🚧 | `docs/mix-transition-phase6.md`。Demucs 末尾ボーカル + tail-fade |
