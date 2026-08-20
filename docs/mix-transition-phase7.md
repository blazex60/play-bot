# MIX Beatmatch / Phrase Mix 実装プラン（Phase 7）

対象リポジトリ: `blazex60/play-bot`
配置先: `docs/mix-transition-phase7.md`
前提文書: [`docs/mix-plan.md`](mix-plan.md) / [`docs/mix-transition-phase6.md`](mix-transition-phase6.md)

---

## 0. この文書の使い方

`mix-plan.md` / `mix-transition-phase6.md` と同じ運用。各 Step の「完了条件」を受け入れ基準として使う。
未決事項の閾値は仮値のまま実装し、実機キャリブレーションは完了条件に残す。

この Phase は、Phase 6 までの「解析ベースの adaptive crossfade」を、**BPM・beat grid・downbeat・phrase・tempo sync を使う Auto DJ 型のミックス**へ拡張する。

この Phase では既存の `MixStream`、Demucs ベースの vocal activity、head/tail key、base swap、曲順最適化を捨てない。
**既存処理を下位レイヤとして残したまま、beatmatch 可能な曲だけ高品質な `beatmix` へ昇格する。**

Phase 7A（本 doc の実装対象）は **analysis payload の拡張のみ**であり、再生音・crossfade の挙動は一切変更しない。7A の完了条件は「既存の受け入れテスト・回帰テストが無変更で通過すること」を含む。

---

## 1. 目的

Phase 6 の adaptive crossfade は、

- ボーカル衝突を避ける（ただし **outgoing の末尾側のみ**。incoming 側は未対応 — §2.4 参照）
- 曲末形状に応じて overlap を変える
- beat / bar 境界へ開始位置を寄せる
- base swap を行う
- head / tail key を解析する

ところまで実装されている。

一方で、現在は **BPM を解析に使っているだけで、2曲の再生テンポ自体は同期していない**。

そのため、BPM が異なる2曲を数小節以上重ねると beat phase が時間とともにずれる。

Phase 7 の目的は次の状態へ移行すること。

```text
Phase 6

Track A ───────────────╲
                        ╳
Track B ───────────────╱

「どこで重ねるか」は賢い
「どう同期させるか」は未実装


Phase 7

Track A
  ├─ BPM
  ├─ beat grid
  ├─ downbeat
  ├─ phrase
  ├─ vocal activity（head + tail）
  ├─ key
  └─ energy
       │
       ▼
Transition Planner
       │
       ├─ beatmix
       ├─ phrase-crossfade
       ├─ crossfade
       ├─ tail-fade
       └─ gapless
       │
       ▼
Tempo Matched PCM
       │
       ▼
MixStream
       │
       ▼
Discord
```

Phase 7 完了時点の目標は、**対応可能な曲同士なら DJ の Sync + Phrase Mix に近い接続を自動生成すること**。

---

## 2. Phase 7 の基本方針

### 2.1 優先順位

J-POP / ボーカル曲中心という既存方針を維持する。

優先順位は次の通り。

1. **vocal clash を起こさない**
2. **phrase 境界を合わせる**
3. **downbeat を合わせる**
4. **tempo を同期する**
5. **低域を衝突させない**
6. **harmonic compatibility**
7. **energy continuity**

BPM が近いからといって、歌と歌を重ねる transition は選ばない。

---

### 2.2 Beatmatch を全曲へ強制しない

すべての曲を無理に BPM 同期しない。

`beatmix` は、解析信頼度・BPM差・vocal-free window・phrase候補などの条件を満たした場合だけ選択する。

条件を満たさない場合は Phase 6 の安全な transition へ降格する。

```text
beatmix
  ↓ unavailable
phrase-crossfade
  ↓ unavailable
crossfade
  ↓ unavailable
tail-fade
  ↓ unavailable
simple-fade / gapless
```

---

### 2.3 Session Tempo 方式を採用する

Phase 7 では、beatmix 中に incoming の tempo を **現在再生中の playback BPM** へ合わせる。

例:

```text
Current
native BPM   = 122
playback BPM = 122

Incoming
native BPM   = 125.5

target BPM   = 122

tempo ratio
= 122 / 125.5
= 0.9721
```

incoming は pitch を維持したまま約 -2.8 % time stretch する。

promotion 後も incoming は 122 BPM で再生を継続する。

これにより、

```text
crossfade中   122 BPM
crossfade後   125.5 BPM
```

のような不連続な tempo jump を発生させない。

次曲も 122 BPM へ安全に合わせられるなら session tempo を維持する。

BPM差が大きく beatmix 不可になった transition では、次曲の native BPM へ session tempo をリセットする。

**実装メモ（7B 向け、現行コードとの整合）**: `createFileSource()` は 1 source = 1 ffmpeg プロセスであり、`MixStream.#promoteIncoming()`（`src/audio/mixStream.js:426-471`）は crossfade で使った source オブジェクトをそのまま `#current` へ差し替えるだけで、新しいプロセスを起こさない。したがって **spawn 時に stretch filter を焼き込めば、その曲は最後まで stretch 済みテンポのまま鳴り続ける**。tempo をランタイムで切り替える state machine は不要— 「次の曲を何 BPM で spawn するか」を決めるロジックだけで済む。ただし `positionSec`（`mixStream.js:44` `#consumedBytes / BYTES_PER_SECOND`）は stretch 後の出力時間になるため、`#resolvePlaybackDurationSec` や `remainingSec` を使う arm ロジックは tempo ratio を考慮しないと狂う。

---

### 2.4 incoming 側の vocal 解析を追加する（Phase 6 からの変更点）

Phase 6 は 2.1 節で「入り側（incoming）の分離: **不要**」と明示的に決定しており（`docs/mix-transition-phase6.md`）、`analyzeVocalActivity()` は末尾窓のみを解析する（`src/audio/vocalActivity.js:136` `tailStart = durationSec - tailWindowSec`）。

Phase 7 の §10 は incoming entry point の探索条件に「vocal開始前」を要求し、§7.2 の phrase score は「vocal activity change」を特徴量に含める。これは **outgoing 側の解析だけでは満たせない**。

Phase 7A では `analyzeVocalActivity()` を拡張し、**head 窓（先頭 30 秒）も同じ Demucs 呼び出しで解析する**。曲全体ではなく head 30 秒 + tail 45 秒の合計 75 秒のみを対象とし、2 プロセスに分けず ffmpeg で 1 本の wav へ連結してから Demucs へ渡すことで、解析コストの増加を「1曲あたり Demucs 1 回」に抑える（詳細は Step 7.11）。

---

## 3. 現状コードとの対応

Phase 7 は主に次の既存モジュールへ載せる。

| 現行モジュール | Phase 7 での役割 |
|---|---|
| `src/audio/trackAnalysis.js` | BPM中心の解析から beat grid / downbeat / phrase metadata まで拡張 |
| `src/audio/vocalActivity.js` | vocal-safe window 判定を継続。**head 窓を追加**（§2.4） |
| `src/audio/keyAnalysis.js` | head / tail key を継続 |
| `src/audio/transition.js` | transition planner を beatmix 対応へ拡張（7C） |
| `src/audio/pcmSource.js` | tempo-matched PCM source 対応（7B）。`createFileSource()` は `startSec` を既に受け取れるが現状どの呼び出し元も使っていない — 7C の entry point 適用はこの既存オプションを使う |
| `src/audio/mixStream.js` | beatmix 実行・EQ envelope・同期済み source の重畳（7D） |
| `src/mix/ordering.js` | native BPM差ではなく「beatmix可能性」も edge cost に反映（7E） |
| `src/audio/analysisQueue.js` | Beat/downbeat/phrase 解析を既存先読みジョブへ統合 |
| `src/player.js` | session playback BPM と transition arm を管理（7B/7C） |
| `src/db/migrations/` | Phase 7 metadata 永続化 |

---

## 4. Track Analysis v3

`ANALYSIS_VERSION` を `3` へ上げる。

Phase 7 では BPM の単一値だけではなく、**head/tail 2 窓分の beat grid を一次データとして保持する。**

全曲通しの beat grid は 7A の対象外とする（transition が使うのは曲末と曲頭だけであり、全曲 decode は解析コストに見合わない。ordering の edge cost も head/tail の要約値だけで足りる）。

### 4.1 目標 payload

```js
{
  version: 3,

  durationSec: 238.42,

  bpm: 123.84,
  bpmConfidence: 0.82,        // Phase 6 と同じ定数式のまま据え置く（後方互換）
  beatConfidence: 0.77,       // 新規。beat grid の実測ばらつきから算出（4.2）

  beatGrid: {
    source: "aubio",
    head: { startSec: 0, beatsSec: [0.381, 0.865, 1.349, 1.833] },
    tail: { startSec: 193.42, beatsSec: [193.8, 194.28, ...] },
  },

  downbeatGrid: {
    source: "heuristic",
    meter: 4,
    head: { downbeatsSec: [0.381, 2.319] },
    tail: { downbeatsSec: [194.28, 196.22] },
    confidence: 0.73
  },

  phrases: {
    head: [{ sec: 15.89, barIndex: 8, score: 0.71, reasons: ["bar-multiple", "vocal-start"] }],
    tail: [{ sec: 201.37, barIndex: 104, score: 0.68, reasons: ["vocal-end", "silence"] }],
  },

  headBpm: 123.9,
  tailBpm: 123.8,

  headKey: "8A",
  tailKey: "8A",

  lastVocalEndSec: 230.2,
  vocalGaps: [],
  firstVocalStartSec: 4.2,      // 新規（§2.4）
  headVocalGaps: [],            // 新規（§2.4）

  ...
}
```

`beatGrid.*.beatsSec` は秒数を小数点 3 桁へ量子化する。`payload_json` を canonical source とし、DB の scalar columns へ全 beat を展開しない（既存の `headBpm` / `tailBeatOffsetSec` と同じ方針）。

---

## 5. Step 7.1 — Beat Grid を保持する

### 実装

現行 `analyzeBpmWindow()`（`src/audio/trackAnalysis.js:67-99`）は `aubiotrack` の出力から beat 時刻配列を既に得ているが、`beatsToBpm()`（同 57-65）が median 区間と `beats[0]` だけを残して配列自体を捨てている。

Phase 7 ではこれを圧縮せず、解析 payload に保存する。

対象は head 窓（0〜30秒。§9.2 に合わせ `HEAD_BPM_WINDOW_SEC` を 20 → 30 に変更）と tail 窓（末尾45秒）の 2 つのみ。全曲 beat grid は持たない。

- 秒数を小数点3桁程度へ量子化
- DB の scalar columns へ全 beat を展開しない
- `payload_json` を canonical source とする

### 4.2 `beatConfidence`（新規）

Phase 6 時点の `bpmConfidence` は `bpm != null ? 0.6 : 0` という定数式（`trackAnalysis.js:94`）で、実測値ではないため校正できない。Phase 7 では beat grid の inter-beat interval から実測の confidence を **別フィールド `beatConfidence`** として算出する。

- 相対 MAD（median absolute deviation / median interval）が小さいほど高い
- 検出 beat 数が窓の理論 beat 数に対して少ないほど低い
- `bpmConfidence` は既存の crossfade 分岐（`transition.js` の `BPM_CONFIDENCE_SNAP` 判定）を変えないため、**そのまま残す**。beatmix の可否判定（7C）は `beatConfidence` を使う

### 完了条件

- `trackAnalysis.js` が head/tail 双方の beat timestamps を返す
- 単体テストで 120 BPM の fixture から約 0.5 秒間隔の grid が得られる
- half / double tempo ambiguity のテストを追加
- `beatConfidence` が疎らな grid（検出漏れを含む）で低くなることを単体テストで確認する
- Phase 6 の `headBeatOffsetSec` / `tailBeatOffsetSec` はそのまま残し、`bpmConfidence` の算出式・値も変更しない
- analysis v2 cache は v3 として再解析される

---

## 6. Step 7.2 — Downbeat Detection

### 6.1 必要性

beat だけ揃っていても bar phase が異なると、

```text
A: 1 2 3 4 | 1 2 3 4
B: 3 4 1 2 | 3 4 1 2
```

のような接続が成立してしまう。

Phase 7 の `beatmix` は必ず downbeat-to-downbeat を基本とする。

---

### 6.2 実装インターフェース

新規:

`src/audio/downbeatAnalysis.js`

```js
export async function analyzeDownbeats(filePath, {
  durationSec,
  beatGrid,
  spawnFn,
}) {
  return {
    source,
    meter,
    head: { downbeatsSec },
    tail: { downbeatsSec },
    confidence,
  };
}
```

`downbeatsSec` は head/tail 窓ごとにネストする（`beatGrid.head`/`beatGrid.tail` と同じ形）。単一の `meter` はどちらか confidence の高い窓から選ぶが、選ばれた `meter` で head/tail 双方の `downbeatsSec` を再計算すること — 窓ごとに別々の meter でフィルタした配列を返すと、`meter` フィールドと実際の配列内容が矛盾する。

transition / player 側から backend 固有の実装を見えなくする。

---

### 6.3 Backend 方針

**7A では heuristic のみを実装する。専用 downbeat detector の spike は 7A の対象外**（新規バイナリ依存を増やさずに beat grid 永続化を先に届けるため）。将来 detector を導入する場合もこのインターフェースの実装差し替えで済む。

heuristic:

- beat grid を 4 拍単位の候補位相へ分ける（3 拍子候補も評価し、4 拍と拮抗する場合は confidence を下げる — 「4/4 と決め打ちしない」という完了条件を満たす）
- 各 beat 周辺の低域 onset / RMS を測る。実装は既存の `analyzeTailShape`（`trackAnalysis.js:17-49`）と `rmsEnvelope`（`vocalActivity.js:96-107`）が使う `silencedetect,astats,ametadata` パターンを流用し、`lowpass=f=150` を通した RMS 包絡から低域アクセントを取る
- 4つの phase のうち bar-head score が最も高いものを beat 1 と推定
- 最良位相と次点の差が小さい場合 confidence を下げる。confidence が低い場合 `beatmix` を許可しない（判定は 7C）

**将来の専用 detector 導入は Phase 7 の出荷をブロックしない。** 導入する場合は `analyzeDownbeats()` の実装を差し替えるだけで済むよう、呼び出し側のインターフェースを固定する。専用 detector を worker thread で実装する場合、`analysisQueue.js` の SIGSTOP/SIGCONT underrun guard は child process のみを対象にしており worker thread には効かない（`src/audio/keyAnalysis.js` の essentia が同じ制約を持つ — 30 秒の worker timeout のみで保護されている）ことに注意する。heuristic 実装は素直に child process（ffmpeg）なので、この制約を継承しない。

### 完了条件

- `downbeatsSec` が monotonic
- meter 未確定時は原則 4/4 と決め打ちせず confidence を下げる
- downbeat confidence が閾値未満なら Phase 6 transition へ fallback（7C で実装）
- detector 失敗が再生を停止しない
- analysis queue の SIGSTOP / SIGCONT 方針を破らない

---

## 7. Step 7.3 — Phrase Grid / Phrase Boundary

Phase 7 では「Aメロ」「Bメロ」「サビ」などの semantic labeling は必須にしない。

DJ transition に必要なのは、**音楽構造上の節目となる bar boundary**。

### 7.1 最小実装

downbeat grid から bar index を生成する。

```text
bar 0
bar 1
bar 2
bar 3
bar 4
...
```

まずは 4 / 8 bar 単位の境界を phrase candidate とする。head 窓・tail 窓それぞれで独立に候補を作る（全曲通しの bar index は持たない — §4 参照）。

---

### 7.2 Phrase Boundary Score

単純な「8小節ごと」だけでなく、候補 boundary の前後で変化量を計算する。

候補 score に使う特徴:

- RMS / loudness change
- low-frequency energy change
- spectral centroid change（7A では省略可 — essentia 依存を増やさないため未実装でよい。`reasons` に含めない）
- onset density change
- vocal activity change（head 窓は §2.4 で追加した `firstVocalStartSec` / `headVocalGaps`、tail 窓は既存の `lastVocalEndSec` / `vocalGaps` を使う）
- silence / near-silence
- 4 / 8 / 16 bar alignment bonus

概念:

```text
phraseScore =
    structuralChange
  + vocalBoundaryBonus
  + barMultipleBonus
  + silenceBonus
```

最初の実装では ML にしない。**完全な純関数として実装し、外部プロセスを持たない**（テスト容易性のため）。

### 新規モジュール

`src/audio/phraseAnalysis.js`

```js
export function buildPhraseCandidates({
  downbeatsSec,
  features,
  vocalActivity,
}) {
  return [
    {
      sec,
      barIndex,
      score,
      reasons,
    }
  ];
}
```

`features` は trackAnalysis 側が既に取得済みの RMS 包絡（`analyzeTailShape` / head 窓用の同等処理）を渡す。

### 完了条件

- 4/8 bar 境界を candidate として出せる
- vocal開始/終了と近い boundary の score が上がる（head/tail 両方でテストする）
- 楽曲末尾45秒以内・先頭30秒以内の transition candidate を取得できる
- phrase解析失敗時も downbeat-only beatmix か Phase 6 へ fallback（7C）

---

## 8. Step 7.4 — Tempo Matching（7B 対象。7A では実装しない）

### 8.1 要件

tempo と pitch を分離する。

以下は禁止。

```text
sample rate を変更
↓
tempo + pitch が同時に変化
```

必要なのは、

```text
tempo   125 BPM → 122 BPM
pitch   維持
```

である。

---

### 8.2 Rubber Band — ffmpeg 内蔵フィルタとして利用する（別プロセスにしない）

Debian bookworm（`node:22-bookworm-slim`、既存 runtime イメージ）の `ffmpeg` パッケージは `--enable-librubberband` 付きでビルドされており、`rubberband` フィルタが `-af` チェーンにそのまま追加できる。**新規パッケージのインストールは不要。**

`PcmSource.createFileSource()`（`src/audio/pcmSource.js:170-213`）は既に単一の `-af` 文字列を組み立てる構造を持つ（loudnorm または `anull`）。tempo 指定がある場合はこの文字列に `rubberband=tempo=<ratio>` を連結する。

```text
file
 ↓
ffmpeg -i file -af "loudnorm=...,rubberband=tempo=0.9721" -f s16le ... pipe:1
```

これにより「同じ PCM を二重 decode する構成は避ける」という要件を、既存の 1 プロセス構成のまま満たす。

`rubberband` フィルタが利用できない ffmpeg ビルドに対しては、起動時に `ffmpeg -filters` の出力を probe し（既存の `command -v aubiotrack` パターンと同様の shape）、無ければ `atempo`（pitch も一緒に動くため beatmix 対象外・soft limit 内でのみ許容）→ どちらも使えなければ beatmix 不可、の順に degrade する。

`PcmSource.createFileSource()` はオプションとして、

```js
{
  measured,
  startSec,
  tempoRatio: 0.9721
}
```

を受け取れるようにする。`startSec` は既存実装済みだが現状どの呼び出し元も使っていない（§3 参照）。

新規:

`src/audio/tempo.js`

```js
export function tempoRatio(nativeBpm, targetBpm) {}

export function canTempoMatch(nativeBpm, targetBpm, options) {}

export function buildTempoFilter({
  nativeBpm,
  targetBpm,
}) {}
```

**half/double 正規化**: `tempoRatio()` は素の `targetBpm / nativeBpm` ではなく、`nativeBpm` を `targetBpm` の共通オクターブ帯（例: targetBpm の 0.6〜1.4 倍レンジ）に正規化してから比を取る。`src/mix/ordering.js` の `bpmDelta()`（既存、`ordering.js:25-37`）は half/double を距離 0 として扱っており、`tempoRatio()` がこれと矛盾する規則（オクターブ違いを常に hard limit 超過として弾く）を持つと、ordering が「近い」と判断した曲を beatmix が拒否し続けることになる。

---

### 8.3 Tempo range

仮値:

```text
SOFT_LIMIT = ±4 %
HARD_LIMIT = ±6 %
```

- ±4 %以内: `beatmix` の通常候補
- 4〜6 %: confidence / transition条件が高いときのみ許可
- 6 %超: beatmix 不可

最終値は実曲で決定する。

---

### 8.4 Session playback BPM

`GuildPlayer` または専用 state に、

```js
{
  nativeBpm,
  playbackBpm,
  tempoRatio
}
```

を保持する。

現在曲が time-stretch 済みなら、次曲の target は `current.playbackBpm`。

```js
targetBpm = current.playbackBpm ?? current.nativeBpm;
```

beatmix 不可 transition では incoming promotion 後、

```js
playbackBpm = incoming.nativeBpm;
tempoRatio = 1;
```

へリセットする。

**§2.3 の実装メモの通り**、tempo は spawn 時に確定させ、promotion 後に再スケジュールし直す必要はない。ただし `MixStream.positionSec` / `remainingSec`、および `#promoteIncoming()` の `promotedConsumedBytes` 計算（`mixStream.js:430-433`）は stretch 後の出力秒数を前提にしているため、`#resolvePlaybackDurationSec()`（`player.js`）が native duration をそのまま渡すと `remainingSec` が tempo ratio 分ずれる。7B では `durationSec / tempoRatio` を渡すか、`setDurationSec` の呼び出し側で補正すること。

### 完了条件

- ±2〜4 % の tempo match が pitch shift なしで動く
- promotion 後に tempo が突然 native BPM へ戻らない
- `/nowplaying` の経過時間が wall-clock playback と一致する
- source duration / remainingSec が tempo ratio を考慮する
- skip / stop / error recovery で stretch process が残らない

---

## 9. Step 7.5 — Transition Planner v2（7C 対象）

`transition.js` の `planTransition()` を拡張する。

### 9.1 Transition type

```js
mode:
  | "beatmix"
  | "phrase-crossfade"
  | "crossfade"
  | "tail-fade"
  | "simple-fade"
  | "gapless"
```

---

### 9.2 beatmix の必須条件

最低条件:

- outgoing / incoming の BPM が有効
- BPM confidence（`beatConfidence`）が十分
- downbeat confidence が十分
- tempo ratio が hard limit 以内
- outgoing に vocal-safe transition window がある（既存 `lastVocalEndSec` ベース）
- incoming entry point が vocal-safe である（§2.4 の `firstVocalStartSec` / `headVocalGaps` ベース）
- overlap が最低2 bars程度確保できる
- source prefetch / analysis が transition 時点までに完了

キー一致は必須条件にしない。

harmonic compatibility は transition score に使うが、キー解析失敗で beatmix を全面禁止しない。

---

### 9.3 TransitionPlan v2

例:

```js
{
  mode: "beatmix",

  confidence: 0.82,

  targetBpm: 122.0,

  outgoing: {
    nativeBpm: 122.0,
    playbackBpm: 122.0,

    exitStartSec: 201.374,
    exitDownbeatSec: 201.374,
    exitBarIndex: 104
  },

  incoming: {
    nativeBpm: 125.5,
    playbackBpm: 122.0,
    tempoRatio: 0.9721,

    entrySec: 7.642,
    entryDownbeatSec: 7.642,
    entryBarIndex: 4
  },

  sync: {
    bars: 4,
    beatsPerBar: 4,
    phaseOffsetSec: 0
  },

  eq: {
    type: "bass-swap",
    swapBar: 2,
    highpassHz: 120
  },

  gain: {
    curve: "equal-power",
    fadeInBars: 4,
    fadeOutBars: 4
  },

  reason: [
    "vocal-safe",
    "tempo-compatible",
    "downbeat-aligned",
    "phrase-boundary"
  ]
}
```

`incoming.entrySec` の適用は、既存の `incomingOffsetSec` スキップ方式（`MixStream.#skipIncomingLead()`、`mixStream.js:345-353`）を流用しない。この方式はデコード済み PCM フレームを読み捨てるだけで、`#fadeElapsedSec` が進まないまま outgoing フレームを返すケースがあり（`mixStream.js:356-364`）、数十秒規模の entry point では fade 完了判定とズレる。**entry point は `createFileSource(path, { startSec: entrySec })` の入力側 seek（`pcmSource.js:180-182`、既存実装済みだが現状未使用）で処理し、`incomingOffsetSec` は数百ms未満の sub-beat 微調整専用として残す。**

---

## 10. Step 7.6 — Entry / Exit Point Search（7C 対象）

固定で「曲末 N 秒」と「次曲先頭」を使わない。

### outgoing candidate

末尾から検索:

1. vocal-free window 内
2. phrase boundary
3. downbeat
4. overlap を確保可能
5. tail key / energy を評価

### incoming candidate

先頭から検索:

1. intro 内の phrase boundary
2. vocal開始前（§2.4 の head 窓解析が前提）
3. downbeat
4. 0〜30秒程度を優先
5. head key / energy を評価

候補ペアを scoring する。

```text
transitionScore =
    vocalSafetyWeight
  + phraseAlignmentWeight
  + tempoCompatibilityWeight
  + downbeatConfidenceWeight
  + harmonicWeight
  + energyWeight
```

最も score の高い candidate pair を採用。

---

## 11. Step 7.7 — MixStream Beatmix Execution（7D 対象）

既存 `MixStream` の PCM mixer は維持する。

Phase 7 で追加する責務は、

- plan の bar-based envelope 実行
- tempo-matched incoming source を受け取る
- downbeat alignment 後の overlap
- EQ envelope の時間制御

とする。

**MixStream 自体に BPM解析や phrase探索を入れない。**

MixStream は「計画を実行するだけ」に保つ。

---

### 11.1 EQ envelope

現行 base swap は crossfade 全体で固定 processor を適用している。

Phase 7 では bass swap timing を bar 単位で制御する。

例: 4 bar mix

```text
bar       1        2        3        4

A LOW    100%     80%      20%       0%
B LOW      0%     20%     100%     100%

A gain   100%     90%      50%       0%
B gain     0%     30%      80%     100%
```

実装ではクリックを避けるため、EQ parameter / gain をフレーム単位で平滑化する。

---

### 11.2 Limiter — 既存機構の overlap 拡張として扱う

`mixFrames()`（`src/audio/fade.js:57-72`）は crossfade 経路に対して既に `OVERLAP_GAIN`（-3dB）+ cubic soft clip + 0.95 clamp を適用済みであり、これは Phase 6 時点で機能している。Phase 7 で新規に必要なのは以下の2点のみ:

1. beatmix の overlap は Phase 6 より長くなる（2〜4 bar = 数秒〜十数秒）ため、既存 limiter が長時間の重畳でも clipping を起こさないことを synthetic PCM の peak test で確認する
2. `tail-fade` 経路（`MixStream.#readTailFadeFrame()`、`mixStream.js:317-343`）は `scaleFrame()` のみでヘッドルーム確保も soft clip も行っていない。beatmix からの fallback 時にこの経路を通るケースがあるため、必要なら `softLimitFrame()`（`fade.js` に export 済みだが現状未使用）を適用する

最低限、

- overlap headroom（既存を維持・長時間 overlap で再検証）
- soft clip / limiter（既存を維持）
- tail-fade 経路への soft clip 適用（新規）
- test fixture に full-scale sine を入れた peak test

を追加する。

---

## 12. Step 7.8 — Phrase-aware Queue Ordering（7E 対象）

`src/mix/ordering.js` の edge cost を Phase 7 用に拡張する。

現行:

```text
BPM
+ key
+ energy
```

Phase 7:

```text
tempo stretch required
+ beatmix feasibility
+ harmonic distance
+ energy difference
+ usable transition window
+ phrase compatibility
```

例えば、

```text
A -> B
BPM差 2%
vocal-free 8 bars
compatible key
→ very low cost

A -> C
BPM差 12%
vocal-to-end
→ high cost
```

とする。

`transitionCost()` から重い解析は行わない。
**既にキャッシュ済みの metadata だけで pure に計算すること。**

**既存の `transitionCost()`（`ordering.js:45-85`）は `cost / parts` という平均を返す設計**であり、新しい項を単純に足すと既存の BPM/key/energy 項の実効重みが薄まる。7E では重み定数（`bpmWeight` / `keyWeight` / `energyWeight` / 新規項の重み）を実曲で再調整し、既存の `ordering.test.js`（8 tests）を更新する。

また `bpmDelta()`（`ordering.js:25-37`）は half/double を距離 0 として扱う。tempo stretch feasibility の項がこれと矛盾しないよう、8.2 の `tempoRatio()` と同じオクターブ正規化規則を使うこと。

---

## 13. Step 7.9 — DB Migration

既存 `track_analysis.payload_json` を canonical metadata として利用するため、beat 配列すべてを column 化しない。

追加 scalar は検索 / ordering に直接必要なものだけにする。

`src/db/migrations/008_beatmix_analysis.sql`

```sql
ALTER TABLE track_analysis ADD COLUMN downbeat_confidence REAL;
ALTER TABLE track_analysis ADD COLUMN phrase_confidence REAL;
ALTER TABLE track_analysis ADD COLUMN meter INTEGER;
```

beat / downbeat / phrase arrays は `payload_json`。

必要性が明確になるまで、

```text
beats_json
downbeats_json
phrases_json
```

の専用 column は追加しない。

`src/web/server/routes/internal.js` の PUT/GET と `src/web/server/testSupport.js` の DDL 複製を同期させる。`src/db/migrations/AGENTS.md` の Key Files 表は現在 `005` で止まっているため、`006`〜`008` の行を追加する。

### 完了条件

- migration の再適用ガードが既存方式（`src/db/migrate.js` の `ADD COLUMN` 事前チェック）と整合
- v2 analysis cache は安全に v3 再解析
- Web process 専用 DB 境界を壊さない
- Bot process から SQLite を直接開かない

---

## 14. Step 7.10 — Analysis Queue / Resource Control

Phase 6 の Demucs resource guard を維持する。

beat/downbeat/phrase 解析を追加しても、再生が最優先。

優先順位:

```text
PCM decode / Discord playback
        >
next track source preparation
        >
transition-critical analysis
        >
2〜3曲先 analysis
```

underrun 時:

1. analysis process を SIGSTOP
2. playback 回復
3. SIGCONT
4. repeated underrun なら analysis job を kill
5. Phase 6 transition へ fallback

**child process のみが対象。** downbeat heuristic（6.3、ffmpeg 子プロセス）はこのガードの対象内。essentia キー解析（`keyAnalysisWorker.js`）は worker thread のため対象外（30秒 timeout のみ）— 将来 downbeat を worker thread 化する場合は同じ制約を継承することに注意。

**7A で対応済み。** `analyzeTrackFile()`（`trackAnalysis.js`）は `signal` を destructure し、duration 解決後・各 `Promise.all` の後に `throwIfAborted` する。子プロセスの強制終了自体は `analyzeTrackFile()` 側の役割ではない — `analysisQueue.js` の `spawnNice()` が spawn した子プロセスを全て `register()` で追跡し、`pump()` の `finally` が **ジョブの成功・失敗・abort を問わず**追跡中の子プロセスを無条件に SIGKILL する（`analysisQueue.js` の `killCurrent()` / `pump()` 参照）。したがって `analyzeTrackFile()` 内で `signal` を個々の `analyzeTailShape()` / `analyzeBpmWindow()` / `analyzeVocalActivity()` / `analyzeKeys()` 呼び出しへ追加で伝播させる必要はない — 伝播させなくても、queue が kill された時点で子プロセスは即座に殺される。`analyzeTrackFile()` 側の `throwIfAborted` は「もう使われない解析結果の計算・永続化を続けない」ためのものであり、プロセス終了の保証ではない。

---

## 15. Prefetch Pipeline

Phase 7 では transition 実行直前に重い処理を始めない。

理想:

```text
Current Track Playing
      │
      ├─ next track download
      │
      ├─ loudness analysis
      │
      ├─ vocal analysis（head + tail）
      │
      ├─ beat grid
      │
      ├─ downbeat
      │
      ├─ phrase candidates
      │
      ├─ key
      │
      └─ tempo matched source preparation
             │
             ▼
      transition armed
```

`#maybeStartCrossfade()` 相当の hot path では、

- DB/cache lookup
- plan lookup
- prepared source attach

だけにする。

外部 process 完了待ちはしない。

---

## 16. Fallback 階梯

Phase 7 の最重要要件。

解析失敗は「停止」ではなく「品質を1段落とす」。

```text
1. beatmix
   downbeat + phrase + tempo sync + vocal-safe（head/tail 双方）

2. phrase-crossfade
   phrase + vocal-safe
   tempo syncなし

3. crossfade
   Phase 6
   vocal-safe（outgoing のみ）+ base swap

4. tail-fade
   vocal-to-end

5. simple-fade

6. gapless
```

各 fallback は reason をログへ残す。

例:

```text
beatmix rejected:
- tempo ratio 1.081 > hard limit
- downbeat confidence 0.32
fallback: crossfade
```

---

## 17. Observability

実機調整のため、transition ごとに structured log を残す。

```js
{
  event: "mix-transition",
  mode: "beatmix",

  outgoingBpm: 122,
  incomingBpm: 125.5,
  targetBpm: 122,
  tempoRatio: 0.9721,

  outgoingDownbeatConfidence: 0.81,
  incomingDownbeatConfidence: 0.76,

  phraseScore: 0.72,
  harmonicDistance: 1,

  overlapBars: 4,
  overlapSec: 7.87,

  fallbackReason: null
}
```

必要なら Web UI へ後から表示できる形にするが、Phase 7 の必須範囲は server log / operation log まで。

---

## 18. テスト戦略

### 18.1 Unit

`node:test` + `node:assert/strict`、ソースファイル隣接の `*.test.js`（`npm run test:server` が自動収集する）。

対象:

- `tempoRatio()`（7B）
- tempo range判定（7B）
- beat grid validation（7A）
- `beatConfidence` の算出（7A）
- downbeat validation（7A）
- bar index（7A）
- phrase candidate scoring（7A）
- entry / exit pair scoring（7C）
- `planTransition()`（7C）
- fallback selection（7C）
- ordering edge cost（7E）

---

### 18.2 Synthetic PCM

テスト音源を生成する。既存の 2 パターンを踏襲する: 純関数は手書きの数値配列（`vocalActivity.test.js` 方式）、実音声が必要なものは ffmpeg 合成 WAV（`silenceTrim.test.js` 方式、`aubiotrack` 不在時は `command -v` probe で skip）。

例:

```text
Track A
120 BPM
4/4
kick on beat 1
32 bars
last 8 bars vocal-free

Track B
124 BPM
4/4
16 bars intro
```

期待:

- target BPM = 120
- incoming ratio ≈ 0.9677
- downbeat-to-downbeat alignment
- 4 bar overlap
- promotion 後も 120 BPM
- pitch が変化しない

---

### 18.3 Failure tests

必須:

- downbeat detector missing
- Rubber Band（ffmpeg フィルタ）unavailable
- incoming source underrun
- analysis timeout
- malformed beat grid
- BPM half/double
- tempo ratio hard limit超過
- vocal-to-end
- next analysis not ready
- skip during beatmix
- stop during tempo stretch
- incoming error during overlap

すべて playback 全体のクラッシュにつながらないこと。

---

## 19. 実曲 QA

J-POP を中心に最低 15 transition。

カテゴリを分ける。

### A. Easy

- BPM差 0〜2%
- 4/4
- 明確なイントロ/アウトロ
- vocal-free window あり

期待: `beatmix`

### B. Medium

- BPM差 2〜5%
- 短いアウトロ
- intro vocal が早い

期待: 2〜4 bar beatmix または phrase-crossfade

### C. Hard

- BPM差 >6%
- ラスサビ直後終了
- pickup vocal
- live / rubato
- half-time ambiguity

期待: 無理に beatmix せず Phase 6 fallback

---

## 20. Phase 7 完了条件

以下をすべて満たす。

### 音響

- beatmix 対象10 transitionで、overlap中に明確な beat drift が発生しない
- downbeat phase が 1拍以上ずれた transition が 0
- vocal-vocal clash が 0
- promotion 前後で tempo jump を感じる箇所が 0
- pitch-preserving stretch に明確な pitch shift がない
- clipping / crackle / 1秒超の無音がない

### 機能

- `beatmix` / `phrase-crossfade` / Phase 6 fallback が自動選択される
- BPM差が hard limit を超えた曲を無理に stretch しない
- session playback BPM が promotion 後も維持される
- non-beatmix transition 後は native BPM へリセットできる

### 安定性

- Demucs / downbeat / Rubber Band のいずれが失敗しても再生継続
- analysis 中の underrun guard が維持される
- skip / stop / disconnect で child process leak がない
- `npm run test:server` 通過
- 既存 acceptance test 通過
- Docker 実環境で10曲以上連続再生できる

---

## 21. 実装順

一度に全部入れない。

### Phase 7A — Analysis foundation

1. analysis v3
2. beat grid 永続化（head/tail 2窓）
3. `beatConfidence` 算出
4. downbeat interface + heuristic backend
5. phrase candidate
6. incoming 側 vocal 解析（head 窓、§2.4）
7. DB migration
8. `analyzeTrackFile()` の `signal` 配線修正（§14 参照。子プロセスの kill 自体は既存の `analysisQueue.js` が担保しており、`analyzeTrackFile()` 側は「abort 後に無駄な計算/永続化をしない」ための `throwIfAborted` のみで足りる）
9. unit tests

**この時点では再生音を変更しない。** `bpmConfidence` を含む既存 `planTransition()` の分岐・`MixStream` の挙動は無変更。`src/player.acceptance.test.js` と `src/audio/phase2.test.js` が無変更で通過することを確認する。

---

### Phase 7B — Tempo Sync

1. ffmpeg `rubberband` フィルタの可用性 probe（新規バイナリ依存なし）
2. `tempo.js`
3. `PcmSource` tempo option（既存 `-af` 文字列への追記）
4. duration / position compensation（`remainingSec` の tempo ratio 補正）
5. session playback BPM
6. synthetic PCM test

**まだ phrase mix へ繋がなくてもよい。**

---

### Phase 7C — Beatmix Planner

1. entry candidate（`createFileSource({ startSec })` の既存オプションを使用）
2. exit candidate
3. pair scoring
4. TransitionPlan v2
5. beatmix eligibility
6. fallback

---

### Phase 7D — Mix Execution

1. MixStream bar envelope
2. bass swap envelope
3. limiter/headroom（tail-fade 経路への適用含む）
4. promotion
5. skip / error recovery
6. acceptance tests

---

### Phase 7E — Ordering / Calibration

1. ordering edge cost（重み再調整・`ordering.test.js` 更新）
2. 15〜30実曲 QA
3. tempo limit calibration
4. downbeat confidence calibration
5. phrase score calibration
6. overlap bars calibration

---

## 22. Phase 8 候補 — Stem Mixing

> **更新**: この節が候補として書いた内容は [`docs/mix-transition-phase8.md`](mix-transition-phase8.md) として実装された。以下は当時の設計メモとして残す。§23 の「stem mixing」非目標行も Phase 8 により上書きされる。

Phase 7 完了後の別 Phase とする。

Demucs を既に使用しているため、

```text
Outgoing
├─ vocal
└─ instrumental

Incoming
├─ vocal
└─ instrumental
```

へ分離し、

```text
outgoing vocal       ───────╲
outgoing instrumental ─────────────╲
                                     ╳
incoming instrumental          ╱────────────
incoming vocal                       ╱────────
```

のような stem-aware transition を行える。

ただし Phase 7 には入れない。

理由:

- CPU負荷が大きい
- cache / temp file 管理が複雑
- stem artifact が transition 品質へ直接出る
- Beatmatch / Phrase Mix の問題と分離して評価すべき

---

## 23. 非目標

Phase 7 では以下を実装しない。

- DJ音声MC / TTS
- scratch
- loop roll
- echo out
- reverb transition
- semantic「Aメロ / サビ」ラベル
- リアルタイムユーザーDJ操作
- MIDI controller
- 全曲への強制tempo sync
- keyを合わせるための大幅pitch shift
- stem mixing

---

## 24. 設計上の重要な禁止事項

### 禁止 1: BPMだけ一致させて beatmix と呼ばない

BPM一致だけでは phase がずれる。

`beatmix` は最低限 downbeat alignment を必要とする。

---

### 禁止 2: incoming だけ overlap 中に stretch して promotion 後に native へ戻さない

```text
overlap: 122 BPM
↓
promotion
↓
突然 125 BPM
```

は禁止。

session playback BPM を維持すること。

**現行アーキテクチャではこれは自然に満たされる**（§2.3 実装メモ参照）。1 source = 1 プロセスで tempo が spawn 時に確定するため、意図的に「promotion 後に native へ戻す」コードを書かない限り発生しない。

---

### 禁止 3: MixStream に解析ロジックを入れない

```text
Analysis
  ↓
Planner
  ↓
Execution
```

の層を維持する。

---

### 禁止 4: 解析完了待ちで realtime playback を止めない

解析が間に合わなければ Phase 6 へ fallback。

---

### 禁止 5: vocal safety より phrase / BPM を優先しない

J-POP では、

```text
perfect beatmatch
+
vocal clash
=
失敗
```

として扱う。

---

## 25. 最終アーキテクチャ

```text
                    ┌──────────────────────────┐
                    │ Track Analysis v3        │
                    │                          │
Audio file ────────▶│ BPM                      │
                    │ Beat Grid（head/tail）    │
                    │ Downbeat                 │
                    │ Phrase candidates        │
                    │ Vocal activity（head/tail）│
                    │ Head/Tail Key            │
                    │ Energy                   │
                    └─────────────┬────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │ Transition Planner v2    │
                    │                          │
                    │ eligibility              │
                    │ entry / exit search      │
                    │ target BPM               │
                    │ tempo ratio              │
                    │ overlap bars             │
                    │ EQ envelope              │
                    └─────────────┬────────────┘
                                  │
                    ┌─────────────▼────────────┐
                    │ Tempo Matched PcmSource  │
                    │ ffmpeg rubberband filter │
                    └─────────────┬────────────┘
                                  │
                outgoing PCM ─────┤
                                  ▼
                    ┌──────────────────────────┐
                    │ MixStream                │
                    │                          │
                    │ frame sync               │
                    │ gain envelope            │
                    │ bass swap                │
                    │ limiter                  │
                    │ source promotion         │
                    └─────────────┬────────────┘
                                  │
                                  ▼
                         Discord AudioPlayer
```

---

## 26. Phase 7 の成功基準

Phase 6 までの MIX は、

> **曲ごとに最適化されたクロスフェード**

だった。

Phase 7 の完成状態は、

> **曲の beat / bar / phrase を理解し、BPMを同期したうえで、DJ のように音楽構造単位で次曲へ渡す Auto DJ**

である。

「クロスフェード時間を賢く決める」のではなく、

```text
どこで入れるか
+
何 BPM で入れるか
+
どの downbeat に合わせるか
+
何 bar 重ねるか
+
どこで bass を渡すか
+
歌を衝突させないか
```

を `TransitionPlan` として明示的に決定することを Phase 7 の中心設計とする。
