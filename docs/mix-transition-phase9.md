# MIX Auto DJ Mix Zone プラン（Phase 9）

対象リポジトリ: `blazex60/play-bot`
配置先: `docs/mix-transition-phase9.md`
前提文書: [`docs/mix-plan.md`](mix-plan.md) / [`docs/mix-transition-phase7.md`](mix-transition-phase7.md) / [`docs/mix-transition-phase8.md`](mix-transition-phase8.md)

---

# 0. Phase 9 の目的

Phase 8 までで、

- BPM解析
- downbeat解析
- phrase解析
- tempo matching
- bass swap
- Demucsによる vocal / instrumental 分離
- stem-aware transition

までは実装された。

ただし実運用では、

> 「DJ MIX」ではなく「曲と曲を自然につないでいるだけ」

に聞こえるケースが多い。

Phase 9では、この問題を単純なクロスフェード調整ではなく、

**「曲間Transition」から「複数小節にまたがるMix Zone」へ設計を変更する**

ことで解決する。

現在:

```text
Song A
██████████████████████████╲
                           ╳
Song B                     ╱████████████████

              transition
```

Phase 9:

```text
Song A
██████████████████████████████████
                  │
                  │
          ┌───────┴──────────────────┐
          │         MIX ZONE         │
          │                          │
A Vocal   ███████████████████╲       │
A Inst    ███████████████╲────────   │
B Inst         ╱████████████████████ │
B Vocal                        ╱████ │
          │                          │
          └──────────────────────────┘
                                     │
Song B                               █████████████████
```

Mix Zone 内では単純な

```text
A gain 1 → 0
B gain 0 → 1
```

ではなく、

```text
導入
↓
blend
↓
bass handoff
↓
vocal handoff
↓
release
```

という複数段階の操作を行う。

---

# 1. 基本方針

Phase 9では以下を行う。

1. Transition observability の追加
2. Stemの事前生成
3. Stem専用Analysis Queue
4. stem-mixをfallbackから第一級candidateへ昇格
5. Mix Zoneを4〜16 barsへ拡大
6. Exit candidate探索範囲を拡大
7. bar-based automation導入
8. outgoing vocalを hold → release 化
9. incoming vocalを独立timeline化
10. frequency automation強化

4-stem化はPhase 9には含めない。

Phase 9では、

```text
vocals
instrumental
```

の2-stem構成を維持する。

---

# 2. 非目標

Phase 9では以下は実装しない。

```text
- Demucs 4-stem
  - vocals
  - drums
  - bass
  - other

- mashup生成
- vocal-vocal常時重畳
- key shifting
- stem単位pitch shift
- AIによるリアルタイムDJ判断
- FX engine
  - echo out
  - reverb throw
  - flanger
  - beat repeat
```

これらはPhase 10以降で検討する。

---

# 3. Phase 9A — Transition Observability

## 3.1 目的

現在の最大の問題は、

**実際にどのtransition modeが何回選ばれているか分かりにくい**

ことである。

Phase 9の変更前に、まず実運用を数値化する。

---

## 3.2 Transition Planning Log

各遷移について以下を出力する。

```text
[MIX PLAN]
from="Song A"
to="Song B"

selected=stem-mix

beatmix:
  eligible=true
  bars=4
  fadeSec=8.00
  score=0.82

stemMix:
  eligible=true
  bars=8
  fadeSec=16.00
  score=0.91

phraseCrossfade:
  eligible=true
  fadeSec=6.00

stemCache:
  outgoing=HIT
  incoming=HIT

exit:
  sec=183.20
  bar=92
  vocalActive=true

entry:
  sec=0.00
  bar=0
  firstVocalSec=12.40
```

reject時:

```text
[MIX PLAN]
selected=phrase-crossfade

beatmix:
  eligible=false
  reason=no-entry-candidate

stemMix:
  eligible=false
  reason=incoming-stem-cache-miss

stemCache:
  outgoing=HIT
  incoming=MISS
```

---

## 3.3 Metrics

プロセス内で最低限以下を集計できるようにする。

```js
{
  totalTransitions: 100,

  selected: {
    stemMix: 61,
    beatmix: 20,
    phraseCrossfade: 12,
    crossfade: 5,
    tailFade: 2
  },

  stemCache: {
    outgoingHit: 95,
    incomingHit: 63
  }
}
```

永続保存は必須ではない。

---

## 3.4 完了条件

```text
10〜20曲連続再生する
↓
全transitionについて
「なぜそのmodeになったか」
をログのみで説明できる
```

---

# 4. Phase 9B — Stem Prefetch

## 4.1 現在の問題

現在はstem分離が遷移直前まで間に合わず、

```text
A playing
│
│                     残り約15秒
│                          ↓
│                     B準備開始
│                          ↓
│                     Demucs
│                     ███████████████████
│
A → B transition
      ↓
incoming stems MISS
      ↓
stem-mix使用不可
```

となる可能性が高い。

---

## 4.2 新しいPrefetchモデル

現在再生中:

```text
A
```

キュー:

```text
A ← current
B ← next
C ← next+1
D ← next+2
```

この場合、

```text
B → HIGH priority stem preparation
C → LOW priority stem preparation
D → 未処理
```

とする。

---

## 4.3 Stem Preparation State

```js
const StemPreparationState = {
  NONE: 'none',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
};
```

track単位で、

```js
{
  videoId,
  priority,
  state,
  queuedAt,
  startedAt,
  completedAt
}
```

を管理する。

---

# 5. Phase 9C — Analysis Queue分離

## 5.1 現在

現在は、

```text
AnalysisQueue
├─ BPM
├─ phrase
├─ vocal analysis
└─ full-track Demucs
```

を共有している。

フルトラックDemucsが長時間queueを占有すると、

リアルタイムtransition planningまで遅延する。

---

## 5.2 新構成

```text
RealtimeAnalysisQueue
│
├─ BPM
├─ downbeat
├─ phrase
├─ key
└─ vocal activity


StemPreparationQueue
│
└─ full-track Demucs
```

---

## 5.3 Priority

```text
RealtimeAnalysisQueue
priority = realtime

StemPreparationQueue
priority:
  B(next)   = high
  C(next+1) = low
```

Stem Queueは基本、

```js
concurrency = 1
```

とする。

---

## 5.4 Playback Safety

stem生成によって、

```text
PCM underrun
Discord audio drop
transition delay
```

が発生してはならない。

CPU pressureを検知した場合、

```text
StemQueue.pause()
```

できる設計とする。

---

## 5.5 完了条件

通常の連続再生で、

```text
A再生中
↓
B stem READY
↓
A→B
↓
incoming stem cache HIT
```

となる。

目標:

```text
incoming stem cache hit rate >= 90%
```

---

# 6. Phase 9D — Transition Candidate Selection

## 6.1 現在

```text
beatmix
  ↓ eligible
採用

  ↓ reject
stem-mix
```

stem-mixがbeatmixのfallbackになっている。

---

## 6.2 Phase 9

すべて独立candidateとして評価する。

```text
                    ┌─ beatmix
                    │
Analysis ───────────┼─ stem-mix
                    │
                    ├─ phrase-crossfade
                    │
                    └─ legacy
                             ↓
                      Candidate Ranker
                             ↓
                       selectedPlan
```

---

## 6.3 Candidate構造

```js
{
  mode: 'stem-mix',

  eligible: true,

  score: 0.91,

  quality: {
    phraseAlignment: 0.9,
    tempoCompatibility: 0.95,
    vocalSafety: 1.0,
    downbeatConfidence: 0.88,
    harmonicCompatibility: 0.7,
    energyContinuity: 0.85,
  },

  fadeSec: 16,
  bars: 8,
}
```

---

## 6.4 Stem Preference

両方のstemが存在し、

```text
stem-mix eligible
```

なら、通常beatmixより優先度を上げる。

例:

```js
function transitionModeBonus(mode) {
  switch (mode) {
    case 'stem-mix':
      return 0.10;

    case 'beatmix':
      return 0.05;

    case 'phrase-crossfade':
      return 0.02;

    default:
      return 0;
  }
}
```

ただし、

```text
stem-mixのcandidate品質が明確に低い
```

場合にはbeatmixを選択可能とする。

---

# 7. Phase 9E — Long Mix Zone

## 7.1 現在

通常のbeatmix:

```text
preferred = 4 bars
minimum   = 2 bars
```

Phase 9では長くする。

---

## 7.2 新しい設定

```js
const MIX_BARS = {
  preferred: 8,
  minimum: 4,
  extended: 16,
};
```

探索順:

```text
16 bars
↓
8 bars
↓
4 bars
↓
fallback
```

ただし16 barsは、

```text
phrase confidence high
stem available
vocal plan usable
```

の場合のみ使用する。

---

## 7.3 時間例

120 BPM / 4拍子:

```text
4 bars
= 8 sec

8 bars
= 16 sec

16 bars
= 32 sec
```

---

# 8. Phase 9F — Exit Candidate探索範囲拡張

## 8.1 問題

現在のtail windowが短い場合、

16〜32秒のMix Zoneを置く自由度がない。

---

## 8.2 方針

tail analysis windowを、

```text
45 sec
```

から、

```text
60〜90 sec
```

へ拡張する。

ただし将来的には秒数固定ではなく、

**曲後半のphrase boundary一覧**

を利用する。

---

## 8.3 Candidate Model

```js
{
  sec: 175.2,

  barIndex: 88,

  type: 'phrase-boundary',

  phrase: 'last-chorus-start',

  vocalState: 'active',

  energy: 0.91,

  score: 0.88
}
```

退出点は、

```text
曲末からX秒
```

ではなく、

```text
phrase boundary
+
downbeat
+
十分なremaining bars
```

で選択する。

---

# 9. Phase 9G — Mix Zone Planner

## 9.1 TransitionPlan v3

Phase 8:

```js
{
  fadeSec,
  curve,
  stems
}
```

Phase 9:

```js
{
  mode: 'stem-mix',

  mixZone: {
    startSec: 182.4,
    durationSec: 16,
    bars: 8,
    beatsPerBar: 4,
    targetBpm: 120
  },

  outgoing: {
    entrySec: 182.4
  },

  incoming: {
    entrySec: 0
  },

  events: []
}
```

---

## 9.2 Event-based Automation

単純な1本のcrossfade curveを廃止する。

```js
events: [
  {
    bar: 0,
    action: 'incoming-instrumental-start'
  },

  {
    bar: 2,
    action: 'outgoing-instrumental-duck'
  },

  {
    bar: 4,
    action: 'bass-swap'
  },

  {
    bar: 6,
    action: 'outgoing-vocal-release'
  },

  {
    bar: 8,
    action: 'incoming-vocal-handoff'
  }
]
```

---

## 9.3 8-bar基本Template

```text
Bar        1   2   3   4   5   6   7   8

A Vocal    █████████████████████████╲
A Inst     ████████████████╲──────────

B Inst         ╱██████████████████████
B Vocal                            ╱███

A LOW      █████████████╲
B LOW                   ╱██████████████
```

---

# 10. Phase 9H — Outgoing Vocal Hold / Release

## 10.1 現在

現在はvocal stemも、

transition開始と同時にフェードアウトする。

```text
A Vocal

████████████╲
             ╲
              ╲
```

このため、

最後の歌唱が弱くなる。

---

## 10.2 新方式

```text
A Vocal

████████████████████████╲
                         ╲
                          0
```

基本は、

```text
hold
↓
phrase end
↓
short release
```

とする。

---

## 10.3 Envelope

```js
outVocal: {
  holdSec: 12.5,
  releaseSec: 0.5,
  curve: 'equal-power'
}
```

---

## 10.4 Planner

```text
last vocal phrase start
        ↓
vocalをforeground維持
        ↓
phrase終了
        ↓
200〜800 ms release
```

---

# 11. Phase 9I — Incoming Vocal Independent Timeline

## 11.1 現在の問題

incoming vocalはinstrumentalと同じタイムラインで再生され、

gain=0

の間もPCMを消費する。

そのため、

```text
「歌詞の途中から急に聞こえる」
```

可能性がある。

---

## 11.2 新方式

instrumentalとvocalでseek位置と再生開始位置を分ける。

```text
Incoming instrumental:

0:00 ─────────────────────────────────>


Incoming vocal:

                0:12 phrase boundary
                     │
                     └─────────────────>
```

---

## 11.3 Source Definition

```js
incoming: {
  instrumental: {
    sourceSeekSec: 0,
    audibleStartBar: 0
  },

  vocal: {
    sourceSeekSec: 12.4,
    audibleStartBar: 8
  }
}
```

---

## 11.4 Vocal Phrase Start

incoming vocal開始位置は、

```text
firstVocalStartSec
```

ではなく可能なら、

```text
nearest vocal phrase boundary
```

を使う。

---

# 12. Phase 9J — Frequency Automation

## 12.1 現在

現在は主に、

```text
Outgoing:
120Hz HPF

Incoming:
120Hz lowshelf +2dB
```

でbass swapしている。

---

## 12.2 Phase 9

LOWとMID/HIGHを時間軸上で別々に制御する。

例:

```text
Bar 1-2

A LOW       100%
A MID/HIGH  100%

B LOW         0%
B MID/HIGH   20 → 50%


Bar 3-4

A LOW       100 → 0%
B LOW         0 → 100%


Bar 5-6

A MID/HIGH  100 → 60%
B MID/HIGH   60 → 100%


Bar 7-8

A Instrumental
60 → 0%
```

---

## 12.3 Filter Automation

固定HPFではなく、

```js
{
  type: 'highpass-sweep',

  fromHz: 40,
  toHz: 180,

  startBar: 2,
  endBar: 6
}
```

のようなautomationを許容する。

ただしPhase 9初期版では、

```text
LOW gain envelope
+
既存HPF
```

だけでもよい。

---

# 13. MixStream変更

MixStreamは、

```text
「fadeの進捗」
```

ではなく、

```text
「Mix Zone内のbar / beat位置」
```

を持つ。

---

## 13.1 Mix Clock

```js
{
  elapsedSec,
  beat,
  bar,
  progress
}
```

計算:

```js
const beatSec = 60 / targetBpm;

const beat =
  elapsedSec / beatSec;

const bar =
  beat / beatsPerBar;
```

---

## 13.2 Automation Evaluation

各20ms frameで、

```js
const gains = evaluateMixAutomation({
  elapsedSec,
  plan
});
```

結果:

```js
{
  outVocal: 1.0,
  outInstrumental: 0.65,

  inVocal: 0,
  inInstrumental: 0.75,

  outLow: 0.2,
  inLow: 0.8
}
```

を得る。

---

# 14. Fallback Ladder

Phase 9の最終fallback構造:

```text
Stem Mix Zone
↓ unavailable / rejected

Beatmix
↓ rejected

Phrase Crossfade
↓ rejected

Legacy Crossfade
↓ rejected

Tail Fade
↓

Simple Fade
↓

Gapless
```

ただしPlannerでは、

```text
Stem Mix Zone
Beatmix
```

を先に両方candidate生成して比較する。

---

# 15. 遷移の選択例

## Case A

```text
A:
BPM 120
strong downbeat
vocal active near end

B:
BPM 122
stem READY
instrumental intro
```

Result:

```text
stem-mix
8 bars
tempo sync
bass swap
out vocal hold
incoming inst underneath
vocal handoff
```

---

## Case B

```text
A:
BPM 120

B:
BPM 120
stem MISS
```

Result:

```text
beatmix
8 bars
```

---

## Case C

```text
BPM confidence low
phrase confidence high
```

Result:

```text
phrase-crossfade
```

---

## Case D

```text
analysis unavailable
```

Result:

```text
legacy crossfade
```

---

# 16. 実装順

```text
Phase 9A
Transition logging
        ↓

Phase 9B
Stem prefetch
        ↓

Phase 9C
Dedicated stem queue
        ↓

Phase 9D
Candidate ranking
        ↓

Phase 9E
8-bar / 16-bar Mix Zone
        ↓

Phase 9F
Exit candidate expansion
        ↓

Phase 9G
Event-based Mix Planner
        ↓

Phase 9H
Outgoing Vocal Hold
        ↓

Phase 9I
Incoming Vocal Independent Timeline
        ↓

Phase 9J
Frequency Automation
```

---

# 17. PhaseごとのAcceptance Criteria

## 9A

```text
全transitionについてselected modeとreject理由が取得できる。
```

## 9B

```text
通常の連続再生でnext trackのstemがtransition前に完成する。
```

## 9C

```text
Demucs実行中でもBPM/phrase解析がブロックされない。
```

## 9D

```text
beatmixがeligibleでもstem-mixを候補として評価できる。
```

## 9E

```text
8 bars以上のMix Zoneが実際に再生される。
```

## 9F

```text
曲末45秒より前のphrase boundaryをexitとして選択可能。
```

## 9G

```text
1本のequal-power crossfadeではなく、
複数bar eventでtransitionが進行する。
```

## 9H

```text
outgoing vocalがtransition開始直後から減衰しない。
```

## 9I

```text
incoming vocalが歌詞途中から突然出現しない。
```

## 9J

```text
bass swapとinstrumental blendが別々の時間軸で動作する。
```

---

# 18. 音質評価項目

実音源で以下を確認する。

```text
[ ] ただのクロスフェードに聞こえない

[ ] 次曲が早い段階から存在感を持つ

[ ] outgoing vocalが最後まで主役として聞こえる

[ ] vocal-vocal clashがない

[ ] incoming vocalがフレーズ頭から始まる

[ ] bassの二重鳴りがない

[ ] bass handoffが認識できる

[ ] beat driftがない

[ ] downbeatがずれない

[ ] Mix Zone中に音圧が大きく落ちない

[ ] promotion時に音量jumpがない

[ ] stem artifactが目立たない

[ ] Discord上でunderrunしない
```

---

# 19. Debug Mode

開発時のみ、

```env
MIX_DEBUG=true
```

で詳細ログを有効化する。

例:

```text
[MIX DEBUG]

A -> B

candidate stem-mix:
  score=0.91
  bars=8
  duration=15.74
  stems=HIT/HIT

candidate beatmix:
  score=0.86
  bars=4
  duration=7.87

selected:
  stem-mix

timeline:

bar 0:
  B instrumental start

bar 2:
  A instrumental duck

bar 4:
  bass swap

bar 6.3:
  A vocal release

bar 8:
  B vocal handoff
```

---

# 20. Phase 9 完了条件

Phase 9完了時には、

```text
A
↓
B
```

という曲間処理ではなく、

```text
A
│
├──────────┐
│ Mix Zone │
└──────────┤
           B
```

として聞こえること。

具体的には、

```text
「曲Aが終わって曲Bが始まった」
```

ではなく、

```text
「曲Aを聴いている途中から
曲Bが入ってきて、
一定時間2曲を使ったMIXが続き、
自然に曲Bへ主役が移った」
```

と認識できることを最終的な聴感Acceptance Criteriaとする。

---

# 21. Phase 10候補

Phase 9完了後に以下を検討する。

```text
Demucs 4-stem

vocals
drums
bass
other
```

これにより、

```text
A drums + B bass
A vocal + B instrumental
B drums導入
bass swap
drum swap
```

のようなさらに高度なtransitionを可能にする。

さらに、

```text
echo out
filter sweep
reverb throw
beat repeat
drop swap
loop transition
```

などをTransition Styleとして追加する。

最終構成:

```text
Track Analysis
      ↓
Transition Candidate Generator
      ↓
Transition Ranker
      ↓
Mix Zone Planner
      ↓
Stem / EQ / FX Automation
      ↓
MixStream
      ↓
Discord
```

Phase 9ではこのうち、

```text
Transition Ranker
Mix Zone Planner
Stem/EQ Automation
```

までを完成させる。

---

## 実装ノート (Phase 9A)

§3 の Transition Observability を実装した。プレイバック挙動・fallback ladder の判定ロジック自体は一切変更していない — 既存の判定結果を後から説明可能にする、純粋な観測レイヤーとして追加した。

### 実装箇所

- `src/audio/transitionMetrics.js`（新規）: プロセス内 in-memory アキュムレータ。`recordTransition({selected, stemCache})` / `getTransitionMetrics()` / `resetTransitionMetrics()`（テスト専用）。§3.3 の例と同じキー命名（`stemMix`/`beatmix`/`phraseCrossfade`/`crossfade`/`tailFade`、モード文字列 `'stem-mix'` 等の camelCase 変換）。永続化なし（DB テーブル追加なし — Bot process は SQLite を開かない、CLAUDE.md）。
- `src/audio/transitionLog.js`（新規）: `buildTransitionPlanReport()`（生の plan オブジェクト群から §3.2 相当の構造化 report を組み立てる純関数）、`formatTransitionPlanLog()`（`[MIX PLAN]` テキストブロックへの整形）、`logTransitionPlan()`（`recordTransition()` を常時呼び、`MIX_DEBUG=true` のときだけ `formatTransitionPlanLog()` の出力を `console.log`）。判定ロジックは一切含まない — beatmixTransition.js/stemTransition.js/transition.js が既に下した決定を後から記述するだけ。
- `src/player.js` の `#maybeStartCrossfade()`: 既存の fallback ladder（`rawPlan = planBeatSyncedTransition(...)` → 条件付き `stemPlan = planStemTransitionFn(...)`）の判定が確定した直後に `buildTransitionPlanReport()` でレポートのスナップショットを取り（`plannedMode`）、TRACK ループ再選択・`forcePlainCrossfade`（incoming source が seek/tempo stretch を実際には適用できなかったケース）による事後ダウングレードを `modeDowngraded` フラグで追跡。実際に `startCrossfade()`/`startStemCrossfade()` を呼ぶ直前（＝ transition が実際にコミットされる、tick ごとではなく transition ごとに一度だけ通る地点）で `report.selected`/`report.downgradedFrom` を確定し `#logTransitionPlanFn(report)` を呼ぶ。テスト用に `logTransitionPlanFn`（既定値 `logTransitionPlan`）を他の Fn 群（`getCachedStemsFn`/`planStemTransitionFn` 等）と同じ DI パターンでコンストラクタに追加した。

### §3.2 ログ形状との対応

- `beatmix`/`stemMix`/`phraseCrossfade` の各候補ブロックは、既存 ladder が実際に評価した結果だけを報告する。`planBeatSyncedTransition()` は tier 1（beatmix）が eligible ならその時点で return し tier 2（phrase-crossfade）を評価しない — この短絡を再現するため、beatmix が勝った場合 `phraseCrossfade`/`stemMix` は `eligible=false, reason=not-evaluated-beatmix-selected` と報告する（§3.2 の例のように 3 候補が常に揃って埋まっているわけではない）。同様に stem-mix はキャッシュ未ヒットや `#stemMixUnavailableKey` によるスキップ時は `reason=stem-cache-miss` 等、実際にスキップされた理由をそのまま出す。これは 3 候補を常に独立評価する設計（Phase 9D の対象）を先取りしないための意図的な選択 — `planBeatmixTransition()`/`planPhraseCrossfade()` を観測目的だけのために二重に呼び出すことも、キャッシュチェックを余分に増やすこともしていない。
- `exit`/`entry` は ladder が最初に選んだ plan（`stemPlan` が eligible ならそれ、でなければ `rawPlan`）のスナップショットから取る。`bar` フィールドは beatmix/stem-mix の `exitBarIndex`/`entryBarIndex`、phrase-crossfade の同名フィールドから拾う（legacy crossfade/tail-fade/simple-fade には小節概念がないため `bar=null`）。`vocalActive`/`firstVocalSec` は outgoing/incoming の解析結果からその場で算出する。
- `stemCache` は実際に fs チェックが走った場合のみ `HIT`/`MISS`、走っていなければ（beatmix 勝利 or `#stemMixUnavailableKey`）`null`（ログ上は `UNKNOWN`）。metrics 側もチェックが走った回だけ `outgoingHit`/`outgoingMiss`/`incomingHit`/`incomingMiss` を加算する。
- `MIX_DEBUG` は既存の boolean env パターン（`src/web/server/config.js` の `DEMO_LOGIN_ENABLED`、`env.FOO === 'true'`）に合わせ `process.env.MIX_DEBUG === 'true'` で判定する。§19 で言及されていたが実装されていなかったフラグを、このドキュメントの記述通りに新規導入した。

### 未決事項 / 既知の制約

- TRACK ループモード（`next === current`）で stem-mix/beatmix が plain crossfade へ再選択された場合、`report.selected`/`downgradedFrom` は正しく更新されるが、`exit`/`entry` の `sec`/`bar` は最初のスナップショット（ダウングレード前の plan）のまま — 特に TRACK ループは常に `entrySec` を 0 へ強制するため、レポート上の `entry.sec` が実際の再生開始位置（0）と食い違う。頻度の低いエッジケース（同一曲ループ）であり、完全な追従には plan 再構築のたびにレポートも作り直す必要があるため、このラウンドでは対応を見送った。
- `stemPlan` を再選択の巻き戻し（TRACK ループで stem-mix → `rawPlan` 再導出）が発生し、かつ再導出後の実際のモードが `'phrase-crossfade'` になるごく稀なケースでは、`normalizeTransitionPlan()` が phrase-crossfade を `mixPlan.mode: 'crossfade'` へ平坦化するため、最終 `selected` は `'phrase-crossfade'` ではなく `'crossfade'` と報告される（`modeDowngraded` 経由で `mixPlan.mode` をそのまま採用しているため）。通常経路（TRACK ループでない）では発生しない。
- 実音源・実 Discord セッションでの「10〜20曲連続再生してログだけで説明できるか」（§3.4 の完了条件そのもの）は、Phase 7A 以来のこのエージェント環境の制約により検証できていない。ユニットテスト（`transitionMetrics.test.js`/`transitionLog.test.js`/`player.acceptance.test.js` の新規ケース）でロジックの正しさは確認済み。
- Web UI への表示（§3 冒頭で触れられている「必要なら」の部分）は実装していない。`getTransitionMetrics()` は現状 Bot process 内でしか読めない — Web process への配線（`botApi.js` 経由の internal API 追加）は本 PR のスコープ外。
- Codex レビュー round 9 で見つかった以下3件は、いずれも純粋な observability（ログ/metrics）にのみ影響し実際の再生挙動には影響しないこと、および本 PR が既に9ラウンドのレビューを経ていることから、このラウンドでは対応を見送った（各スレッドへの返信にも同じ理由を記載）:
  - **TRACK ループで stem-mix → plain crossfade へ再選択された際、`exit` フィールドが古い（stem plan 時点の）スナップショットのまま** — `entry` は既に `pendingEntrySec` で再結線済みだが、`exit` の同様の再結線には `transitionLog.js` の private な `exitInfo()` を export し、「stem plan からのダウングレードの場合のみ」という `modeDowngraded` より狭い条件で呼び直す必要がある。
  - **private video などで B の起動に失敗し B→C へ再試行した場合、A→C という実際に起きた継続が `totalTransitions`/ログのどちらにも記録されない** — `resolvedGaplessFrom`（起源トラック A）を、失敗した B の呼び出しをまたいで C の呼び出しまで保持するよう `playNext()` の再試行チェーンを変更する必要がある。
  - **`incomingerror`（`startCrossfade()` が一度 true を返した後、実際の昇格前に incoming ストリームが失敗するケース）で、既にカウント済みの遷移が再試行成功時に二重カウントされうる** — 昇格確認まで記録を遅らせるか、`transitionMetrics.js` に rollback API を追加する必要があり、いずれも単一ファイル内には収まらない変更。

### 完了条件（§3.4/§17 9A 相当）

- [x] `[MIX PLAN]` ログ（`MIX_DEBUG=true` 時）に `from`/`to`/`selected`/`beatmix`/`stemMix`/`phraseCrossfade`/`stemCache`/`exit`/`entry` が揃って出力される
- [x] metrics アキュムレータ（`totalTransitions`/`selected.*`/`stemCache.*`）が `MIX_DEBUG` の値に関わらず常時更新される
- [x] 既存の fallback ladder / 実際に選ばれる transition mode / フェード曲線は無変更（`bun run test:server` で Phase 6-8 の既存テストが1件も変わらず通過）
- [ ] 実音源・実運用セッションでの「ログだけで全 transition の理由を説明できる」検証（上記未決事項参照 — このエージェント環境では実施不可）

## 実装ノート (Phase 9B)

§4 の Stem Prefetch を実装した。§4.1 が説明する問題（stem 分離が遷移直前まで間に合わない）そのものの解決手段——B（next）を HIGH、C（next+1）を LOW 優先度で先読みする——を配線した。§5（Phase 9C: 専用 pausable キューへの分離）には一切手を付けていない。transition mode の選択ロジック（Phase 9D の対象）も無変更 — 本 PR が変えるのは「`getCachedStems()` がいつ HIT を返すようになるか」だけで、「どの mode が選ばれるか」の判定には触れていない。

### 実装箇所

- `src/audio/stemPrefetch.js`（新規）: §4.3 の `StemPreparationState`（`NONE`/`QUEUED`/`PROCESSING`/`READY`/`FAILED`、指定の値そのまま）と `StemPrefetchPriority`（`HIGH`/`LOW`）、および `StemPrefetchTracker` クラス。videoId をキーに `{videoId, priority, state, queuedAt, startedAt, completedAt}`（§4.3 そのまま）を保持する、純粋な in-memory bookkeeping のみのクラス — ファイルシステムにも子プロセスにも一切触れない。`queue()`/`markProcessing()`/`markReady()`/`markFailed()`/`get()`/`prune()`/`counts()`/`snapshot()` を公開する。§5 の `RealtimeAnalysisQueue`/`StemPreparationQueue` のような実スケジューラは持たない（意図的 — Phase 9C の対象）。
- `src/player.js` の `#prefetchUpcoming()`: 既存の `upcoming = queue.upcoming().slice(0,3)`（TRACK ループ時は `[current]`）から `first`（B）/`second`（C）を取り出し、`isNormalizeDurationAllowed()` を満たす場合のみ `#ensureStemPrefetch(first, HIGH)` / `#ensureStemPrefetch(second, LOW)` を呼ぶ。呼び出し末尾で `#stemPrefetchTracker.prune(upcoming の videoId 一覧)` を実行し、ウィンドウから外れた古いエントリを回収する。D（next+2）以降は既存の `#ensureAnalysisPrefetch()`（BPM/phrase の軽量先読みのみ）の対象のままで、本 PR での変更なし — §4.2 の「D → 未処理」をそのまま維持している。
- `#ensureStemPrefetch(track, priority)`（新規）: HIGH と LOW で経路が異なる。
  - **HIGH（B）**: 純粋に観測用。B は既に Phase 8 の `#ensureFullPrefetch()` → `#scheduleAnalysis()` パイプラインでフルダウンロード・normalize・解析・`separateTrackStemsFn()` 呼び出しまで一式が走る（Phase 9B 以前から）。この経路をそのまま利用し、`#prefetchEntries` の `kind:'full'` エントリに相乗りするだけで、`#prefetchTrackFn` を独自に呼ぶことは一切しない — 同じファイルに対する二重ダウンロード経路を新設しないため。
  - **LOW（C）**: 既存パイプラインでは C の音声を Demucs にかけるまで手元に残す仕組みが無かった（`#ensureAnalysisPrefetch()` は BPM 解析が終わった瞬間に一時ファイルを削除する）。そのため `#runLowPriorityStemPrefetch()`（新規）を追加し、`#prefetchTrackFn` → `#stageTempFileCopyFn` → `#separateTrackStemsFn` という、`#scheduleAnalysis()` と同型の staged-copy パターンを C 専用に独立実行する。`this.#analysisQ().enqueue()` を通す（`spawnNice`/`signal` を受け取る）ことで、mixer underrun 時の SIGSTOP/kill が他の解析ジョブと同様に効く（§5.4 の精神を、専用キューを作らずに満たす）。
  - どちらの経路も **`getCachedStemsFn()` のミス確定後にのみ** dispatch する。HIT なら即 `markReady()` して return（`#stemCacheHit` の「positive result のみ memoize」と同じ思想）。
- `#scheduleAnalysis()`: `separateTrackStemsFn()` 呼び出し後に `.then/.catch` を追加し、そのvideoId が `#stemPrefetchTracker` に登録されている場合のみ `markReady()`/`markFailed()` する。これが無いと、HIGH（B）の完了は「次に `#ensureStemPrefetch()` が同じ videoId を再チェックするタイミング」でしか分からず、B が実際に current に昇格した時点で「next/next+1 のみを見る」`#ensureStemPrefetch()` の対象から外れてしまうため、実運用では PROCESSING のまま観測上停止するケースが起きうる（テストで実際に踏んだ — 後述）。現在の CURRENT トラック（A）は `#ensureStemPrefetch()` から一度も登録されないため、この hook は A の bookkeeping を新設しない（`this.#stemPrefetchTracker.get(videoId)` が null を返す）。
- `GuildPlayer#stemPrefetchStatus`（新規 getter）: `#stemPrefetchTracker.snapshot()` を返すだけの読み取り専用プロパティ。テスト/観測用で、どの playback 判断にも使われない。

### §4.2 の図との対応

```text
A (current) → 変更なし（#ensureOutgoingStemPrep() は Phase 8 のまま）
B (next)    → #ensureStemPrefetch(first, HIGH)
C (next+1)  → #ensureStemPrefetch(second, LOW)
D (next+2)  → 未処理（#ensureAnalysisPrefetch() の軽量パスのみ、Phase 9B 以前と同一）
```

### §5.4 Playback Safety との関係（精神のみ）

専用 pausable キュー自体は Phase 9C の担当だが、「stem 準備が realtime playback をブロック/遅延させてはならない」という要求は今回も守っている。

- `#ensureStemPrefetch()`/`#runLowPriorityStemPrefetch()` はどちらも `#prefetchUpcoming()`（track 開始/昇格時にのみ呼ばれる）からしか呼ばれず、戻り値を誰も `await` しない — fire-and-forget。`#maybeStartCrossfade()` など realtime 判断側のコードパスからは一切参照されない。
- LOW（C）の実処理は `this.#analysisQ().enqueue()` 経由なので、既存の `noteUnderrun()`/SIGSTOP・`MAX_PAUSES` 超過時の kill が Phase 8 以前と全く同じ形で効く。専用レーン分割（§5.2/§5.3）が無いため「B の HIGH ジョブが C の LOW ジョブを優先して先に実行される」保証はまだ無く、実際の順序は「呼び出し順で `enqueue()` に積まれた順」（FIFO）でしかない — これは意図的な簡略化で、タスクの指示どおり「call order を最小限の priority 表現とする」を採用した。

### 未決事項 / 既知の制約

- **HIGH（B）の READY 検出は 2 経路の組み合わせに依存する**: (1) `#scheduleAnalysis()` からの直接コールバック（上記）と (2) 次回 `#ensureStemPrefetch()` 呼び出し時の `getCachedStemsFn()` 再チェック。(1) を追加する前は、テスト（`getCachedStemsFn` が常に MISS を返す stub のケース）で B が `processing` のまま止まる回帰を実際に踏んだ。(1) を追加したことで実運用（`getCachedStemsFn`/`separateTrackStemsFn` が同じ実ファイルシステムを参照する本番経路）では解決しているはずだが、「本 GuildPlayer インスタンス以外が同じ videoId を分離した」ケース（他ギルドの GuildPlayer が先に同じ曲を再生していた等）は (2) の再チェックだけが頼りで、次の `#prefetchUpcoming()` チェックポイントまで `processing` 表示のまま残りうる。observability 専用の値であり、どの playback 判断にも使われないため実害はないが、正確なリアルタイム状態ではない。
- **優先度は「どちらが先に `enqueue()` されるか」以上の意味を持たない**: §5.3 が要求する「StemPreparationQueue の中で HIGH が LOW より先に処理される」という保証は、専用キューが無い現状では作れない。B と C がほぼ同時に MISS 判定された場合、どちらの Demucs ジョブが先に走るかは実装の呼び出し順（`#prefetchUpcoming()` 内で B → C の順に呼んでいる）に依存する、弱い保証でしかない。
- **C（LOW）はフルダウンロード＋normalize を伴う**: 既存の `#ensureAnalysisPrefetch()`（軽量 BPM 解析のみ、完了後すぐ削除）とは別に、`#runLowPriorityStemPrefetch()` が独自にダウンロードする。同じ動画を「BPM 解析用」と「stem 分離用」で二重にダウンロードしうる（キャッシュされた解析結果があっても、stem キャッシュが無ければ stem 用ダウンロードは走る — 逆に BPM 解析キャッシュが無くても stem キャッシュがあれば stem 用ダウンロードは走らない、の非対称）。1 曲分の帯域/CPU コストが増える意図的なトレードオフ — 「B と同じ full-prefetch 経路に C も乗せる」案も検討したが、`player.acceptance.test.js`「persistent analysis cache skips Demucs lookahead」テストが確認している既存の保証（BPM 解析キャッシュが HIT の場合、2〜3 曲先の lookahead はダウンロードしない）と衝突するため採用しなかった — stem キャッシュの有無は BPM 解析キャッシュの有無と独立でなければならないため。
- **キャンセル API が無い**: §4 の指示どおり、in-flight の Demucs 実行を途中で止める仕組みは実装していない。次track が変わっても（reorder/skip/remove）、既に dispatch 済みの分離ジョブはそのまま完走 or 失敗するまで走り続ける。`StemPrefetchTracker.prune()` は QUEUED/PROCESSING のエントリを能動的に消さず、terminal state（READY/FAILED）に達してから、かつアクティブウィンドウ外になった場合にのみ回収する — この設計はテストで検証済み（`stemPrefetch.test.js`）。
- **`incoming stem cache hit rate >= 90%`（§5.5、Phase 9C の完了条件として書かれているが、9B が実際に動かす数値）は実音源・実運用セッションでの計測が必要な指標であり、このエージェント環境では検証できない** — phase7.md/phase8.md が随所で書いている制約と同じ（実音声ファイルでの Demucs 実行・実 Discord VC 接続はこの環境では行えない）。ユニットテスト（`stemPrefetch.test.js`、`player.acceptance.test.js` の新規ケース）は「HIGH/LOW それぞれが正しいタイミングで dispatch される」「cache HIT なら再ダウンロードしない」「優先度が正しく昇格する」「stale なエントリが正しく pruning される」ことを DI モックで確認しているが、実際の hit rate 改善そのものは未検証・未達成として報告する。

### 完了条件（§17 9B / §5.5 相当）

- [x] §17 9B: 「通常の連続再生で next track の stem が transition 前に完成する」— B は Phase 8 の既存フルプリフェッチ経路で、C は本 PR の LOW パイプラインで、どちらも `getCachedStemsFn()` が MISS の間だけ分離が dispatch される（ユニットテストで確認）
- [x] next（B）= HIGH、next+1（C）= LOW の優先度ラベリングが `StemPrefetchTracker` に記録され、next が繰り上がった場合に LOW→HIGH へ昇格する
- [x] next+2（D）以降は §4.2 のとおり本 PR の対象外のまま（stem prefetch は一切トリガーされない）
- [x] `bun run test:server` で Phase 6-9A の既存テストが1件変わらず通過（1件だけ、Phase 9B 追加前後で意味が変わった `player.acceptance.test.js` の既存テストに `getCachedStemsFn` の stub を追加 — 詳細は下記「テストへの変更」参照。ロジック側の変更は無し）
- [x] realtime playback 経路（`#maybeStartCrossfade()` 等）から prefetch 呼び出しが一切 `await` されない（fire-and-forget であることをコードレビュー・テストの両方で確認）
- [ ] `incoming stem cache hit rate >= 90%`（§5.5）— 実運用計測が必要で本エージェント環境では未検証（上記未決事項参照）

### テストへの変更

- `player.acceptance.test.js`「persistent analysis cache skips Demucs lookahead」に `getCachedStemsFn` の HIT スタブを追加した。このテストは元々「BPM 解析キャッシュが HIT の場合、lookahead は再ダウンロードしない」ことだけを検証していたが、Phase 9B が C にも独立した stem-cache チェックを追加したことで、`getCachedStemsFn` を明示的にスタブしない限り（デフォルトの実 `getCachedStems()` は当然 MISS を返す）C 用の LOW パイプラインが余分な `prefetchTrackFn` 呼び出しを発生させ、このテストの `prefetchCalls === 1` アサーションと衝突していた。stem キャッシュを HIT に固定することで、テストの本来の意図（BPM 解析キャッシュの効果測定）と Phase 9B の新しい次元（stem キャッシュの有無）を分離した。

### 追記: Codex レビュー対応（PR #44）

初回実装後のレビューで見つかった実バグ3件を修正した（コミット ee3e54e）:

- **P1: LOW プリフェッチのサブプロセスが実際には pausable でなかった** — `#runLowPriorityStemPrefetch()` は `this.#analysisQ().enqueue()` 経由で動くため一見 pausable に見えるが、実体の `#prefetchTrackFn`（本番実装は `normalize.js` の `prefetchTrack()`）は yt-dlp/ffmpeg をモジュールレベルの `spawn` で直接起動しており、`spawnNice`/`signal` を一切受け取っていなかった。そのため mixer underrun 時に `noteUnderrun()` が SIGSTOP しようとしても、対象の子プロセスがキューの `children` Set に登録されておらず何も止まらない — LOW プリフェッチが実際に PCM underrun / Discord audio drop を引き起こしうる本物のバグだった。`downloadAudio()`/`analyzeLoudness()` に `trimSilence()` と同型の `spawnFn` オプションを追加し、`prefetchTrack()` → `#runLowPriorityStemPrefetch()` まで `spawnNice` を貫通させて修正した。
- **QUEUE ループ境界での prefetch 欠落** — `GuildQueue.upcoming()` はループ境界で wrap しないため、最後の曲では B・C ともに prefetch 対象が存在せず、最後から2番目の曲では C（wrap 後の先頭）が LOW 対象から漏れていた。`GuildQueue.wrappedUpcoming()`（新規）を追加し、QUEUE ループ時のみ `next()` と同じ wrap 挙動を再現する。
- **HIGH エントリが PROCESSING のまま止まる経路** — `#scheduleAnalysis()` 内で、staging 失敗・abort・`#runAnalysis()` 自体の reject など「`separateTrackStemsFn()` に到達する前に終了する」経路では、既存の markReady/markFailed 呼び出しが一度も実行されず、`StemPrefetchTracker` のエントリが PROCESSING のまま永久に残っていた（`prune()` は QUEUED/PROCESSING を意図的に回収しないため）。該当する早期リターン・catch 節すべてに `markFailed()` を追加し、次回チェックポイントでの再試行を可能にした。

以下2件は今回のラウンドでは対応せず、既知の制限として残す（上記スレッドへの返信にも記載）:

- **キュー変更（move/remove/optimize/shuffle）時に prefetch ウィンドウが即再計算されない** — `botApi.js`/`queueEditorInteractions.js` 側の変更が必要な cross-file な変更であり、staleness も「次の `#prefetchUpcoming()` チェックポイントまで」に有界なため優先度を下げた。
- **HIGH（B）が LOW（C）より先に dispatch される保証がない** — 上の「優先度は enqueue() 順以上の意味を持たない」の節で述べた通り、これは専用 priority queue（Phase 9C, §5.2/§5.3）そのものが解決すべき課題であり、9B の場当たり的な修正では本質的な解決にならないと判断した。Phase 9C で対応する。

## 実装ノート (Phase 9C)

§5 の Analysis Queue 分離を実装した。§5.1 が説明する問題（BPM/phrase/vocal 解析とフルトラック Demucs が単一 FIFO を共有し、後者が前者を長時間ブロックしうる — docs/mix-transition-phase8.md §9 の既知の未決事項）そのものを解消する、純粋なインフラ/スケジューリング変更。**どのトラックが解析されるか・いつ解析されるか・どの transition mode が選ばれるかは一切変更していない** — 変えたのは「フルトラック Demucs をどのキューインスタンスで実行するか」だけ。

### 実装箇所

- `src/audio/analysisQueue.js`: `createAnalysisQueue()` ファクトリ自体は変更なし（同じ closure 構造・同じ dedup/pause/kill machinery）。ここに以下を追加した。
  - `getStemPreparationQueue()`（新規）: `getAnalysisQueue()` と対になる、もう一つの `createAnalysisQueue()` インスタンスを保持するモジュール内シングルトン。`getAnalysisQueue()` は無変更（既存の呼び出し元・既存のテストへの影響ゼロ）。
  - `setStemPreparationQueueForTest()`（新規）: `setAnalysisQueueForTest()` と対称なテスト専用オーバーライド。
  - `queue.pause(source)` / `queue.resume(source)`（新規、返り値オブジェクトに追加）: §5.4 の `StemQueue.pause()` に対応する、明示的な一時停止/再開コマンド。`noteUnderrun()`/`noteUnderrunCleared()` の debounce 付き自動シグナルとは別の入口だが、内部実装は同じ `underrunSources` Set・同じ `pauseCount`/`maxPauses`/`maxStoppedMs` kill-timeout machinery を共有する（`applyPause()` という共通ヘルパーに切り出した — `noteUnderrun()` はこれを debounce 判定の後に呼び、`pause()` は即座に呼ぶ、という違いだけ）。`resume()` は `noteUnderrunCleared()` そのもの（別 API 名で同じ関数を指すだけ）。CPU pressure 検出そのもの（自動トリガー）は実装していない — タスクの指示どおり、pause/resume という「能力」だけを追加した。
- `src/player.js`:
  - `#stemQueue` フィールド + コンストラクタの `stemQueue = null` DI パラメータ + `#stemQ()` ヘルパー（`this.#stemQueue ?? getStemPreparationQueue()`）を、既存の `#analysisQueue`/`#analysisQ()` と全く同じパターンで追加した。
  - `#initMixerPipeline()` の `mixStream.on('underrun', ...)`: 既存の `this.#analysisQ().noteUnderrun(this)` に加えて `this.#stemQ().noteUnderrun(this)` を追加。`underrunClear` も対称に `this.#stemQ().noteUnderrunCleared(this)` を追加。§5.4 が要求する「Demucs 実行中の CPU pressure を realtime underrun から連動して緩和する」配線はこれだけ — 新しい自動検知トリガーは発明していない。`stop()` にも同様に `this.#stemQ().resume(this)`（`noteUnderrunCleared()` の別名）を追加し（既存の `#analysisQ().noteUnderrunCleared(this)` と対称）、停止したギルドが stem キューを他ギルド分も含めて pause させたままにしないようにした。
    - **Codex レビュー (PR #45, round 1) で修正**: 初回実装はここで即時の `pause(this)`/`resume(this)` を使っていたが、生の mixer underrun イベントは瞬間的な単発スタックを何度も発火しうる（jittery）ため、それぞれが `pauseCount` に即座にカウントされ `MAX_PAUSES` を超えて長時間実行中の Demucs ジョブが誤って kill される問題があった。realtime queue 側と同じ debounce 付き `noteUnderrun()`/`noteUnderrunCleared()` 経由に統一済み（詳細は下記「追記」参照）。`pause()`/`resume()` 自体は §5.4 の明示的コマンドとして引き続き公開されているが、この自動配線からは外れている。
  - `#scheduleAnalysis()`: 元は「BPM/phrase 解析 → 分離」を単一の `this.#analysisQ().enqueue(...)` ジョブ内で直列に実行していた。これを、BPM/phrase 解析部分は引き続き `this.#analysisQ().enqueue(...)`（realtime queue）で行い、`!signal?.aborted && stagedPath` の分岐に入った時点で `this.#stemQ().enqueue(...)`（stem queue）へ分離ジョブを **await せず** 発火するよう変更した。「await しない」がここでの本質的な変更点 — 分離を待ってしまうと realtime queue のジョブが Demucs の完走まで `running=true` のままになり、次に並んでいる別トラックの BPM/phrase ジョブを事実上ブロックしてしまう（§5.1 が解決しようとしている問題をキュー分割後も再現してしまう）。段階的な変更:
    - staged copy の cleanup と `#scheduledAnalysisTokens` の解放（既存の finally 相当）は `finishAnalysisAttempt()` という共有ヘルパーに切り出し、「分離を dispatch しない」経路（abort 済み or staged copy 無し）と「分離を stem queue の job に投げた」経路のどちらか一方から、必ず一度だけ呼ばれるようにした（後者は stem queue job 自身の `.finally()` から呼ぶ — realtime job 自身の finally ではない、そこが今回の分割の核心）。
    - `!signal?.aborted` のチェックは realtime job 自身の signal のまま（分離を dispatch するかどうかの判断はそのまま realtime queue 側の abort 状態を見る）。stem queue 側の job にも独立した `stemSignal?.aborted` チェックを追加している（stem queue 自身が pause/kill された場合に defensive に効く）。
    - Phase 9B の HIGH（B）検出用コールバック（`#stemPrefetchTracker.markReady()`/`markFailed()`）はそのまま、stem queue 側の `.then(success, error)` に移設しただけ — ロジック自体は無変更。
  - `#runLowPriorityStemPrefetch()`（Phase 9B の LOW/C 経路）: ジョブ全体（download + stage + Demucs）を `this.#analysisQ().enqueue(...)` から `this.#stemQ().enqueue(...)` に丸ごと差し替えた。このジョブは download を含めて「C の stem を用意する」以外の目的を持たないため、分割はせず全体を stem queue に移した。
  - `#ensureAnalysisPrefetch()`（D 以降の軽量 BPM lookahead、Demucs なし）は無変更 — 引き続き `this.#analysisQ()`。
- `src/player/test-helpers.js`: `makePlayer()` に `analysisQueue`/`stemQueue` の DI パススルーを追加（既存の他の `xxxFn` オプションと同じパターン）。

### §5.2/§5.3 の構成との対応

```text
RealtimeAnalysisQueue  = getAnalysisQueue()       — 無変更のシングルトン
  ├─ BPM / downbeat / phrase / key                — #scheduleAnalysis() の解析部分、#ensureAnalysisPrefetch()
  └─ vocal activity

StemPreparationQueue   = getStemPreparationQueue() — 新規シングルトン、concurrency=1（createAnalysisQueue() は元々シリアル）
  └─ full-track Demucs
      ├─ outgoing (A, Phase 8)                    — #scheduleAnalysis() の分離ステップ
      ├─ next (B, HIGH, Phase 9B)                 — 同上（B は #scheduleAnalysis() に相乗り、9B のノート参照）
      └─ next+1 (C, LOW, Phase 9B)                — #runLowPriorityStemPrefetch()
```

### 未決事項 / 既知の制約

- **CPU pressure 検出は未実装**: タスクの指示どおり、`StemQueue.pause()`/`resume()` という能力のみ実装し、それを自動的に呼び出す CPU 監視は実装していない。唯一の自動トリガーは realtime queue 自身の underrun イベント（既存の `noteUnderrun()`/`noteUnderrunCleared()` と同じ mixStream イベント）で、これは §5.4 の例示どおり「Demucs 実行中に実際に underrun が起きている」ケースへの対応であり、それ以外の CPU 負荷（他プロセス起因など）は関知しない。
- **キュー内の優先度は Codex レビュー（PR #45 round 1）で実装済み**（下記「追記」参照）: `StemPreparationQueue.enqueue(fn, { priority: 'high' })` は、まだ実行が始まっていない pending な非 HIGH ジョブより手前に挿入される。ただし **既に実行中の LOW ジョブへの真のプリエンプション（横取り）は未実装** — concurrency=1 のため、HIGH ジョブが到着した時点で既に走っている LOW の Demucs 実行はそのまま完走を待つ。これは意図的なスコープ限定であり、バグではない（下記「追記」参照）。
- **`#scheduleAnalysis()` の分離ステップは fire-and-forget になった**: 9C 以前は `#scheduleAnalysis()` の返り値 Promise が分離の完了まで resolve/reject しなかったが、9C 以降は BPM/phrase 解析が終わった時点で resolve する（分離は別ジョブとして stem queue 上で並行に進む）。`#scheduleAnalysis()` の返り値を誰も awai/consume していないこと（fire-and-forget 呼び出しのみ）をコードリーディングで確認済みだが、将来誰かがこの返り値に依存するコードを追加する場合はこの変更点に注意が必要。
- **§5.5 の完了条件の検証範囲**:
  - 「Demucs実行中でもBPM/phrase解析がブロックされない」は **構造的にのみ** 検証できる、かつ検証済み: `RealtimeAnalysisQueue`/`StemPreparationQueue` は `createAnalysisQueue()` の完全に独立した closure インスタンスであり（`jobs`/`running`/`paused` 等の状態を一切共有しない）、FIFO の意味で一方が他方の前に割り込むことは構造上不可能。ユニットテスト（`analysisQueue.test.js`「pausing one queue instance never touches a separate instance」）と player 統合テスト（`player.acceptance.test.js` の Phase 9C セクション、stem queue mock への enqueue 回数と realtime queue mock への enqueue 回数を独立に計測）の両方で確認した。ただし「実際の Demucs 実行の重さ（CPU 時間）が本当に BPM/phrase 解析のレイテンシに影響しないか」という実測（実音源・実 CPU 負荷下でのタイミング計測）はこのエージェント環境では実施できない — phase7/8/9A/9B のノートが繰り返し書いている同じ制約。
  - 「incoming stem cache hit rate >= 90%」は Phase 9B のノートに書かれていたとおり実運用計測が必要な指標で、9C 側の変更（どのキューが実行するか）はこの数値そのものには影響しない設計（同じ dedup・同じキャッシュチェックロジック、実行順序と並行性のみ変更）と考えられるが、これも実音源・実 Discord セッションでの計測が必要であり本エージェント環境では検証できない。

### 追記: Codex レビュー対応（PR #45）

round 1 で見つかった5件（P1×2, P2×3）を修正した:

- **P1: HIGH（B）が pending な LOW（C）より先に dispatch される保証がなかった** — `createAnalysisQueue()`（`analysisQueue.js`、`RealtimeAnalysisQueue`/`StemPreparationQueue` 共通のファクトリ）の `enqueue(fn, options)` に `{ priority: 'high' }` を追加。`jobs` 配列の中で、まだ実行が始まっていない非 HIGH ジョブより手前に挿入する（HIGH 同士の相対順序は維持）。`#scheduleAnalysis()`（B の HIGH パス）は `#stemPrefetchTracker` が HIGH と記録している videoId のときだけ `priority: 'high'` を渡し、`#runLowPriorityStemPrefetch()`（C の LOW パス）は常に `priority: 'low'`（内部的には非 high 扱い）。**既に実行中のジョブへの真のプリエンプションは実装していない** — concurrency=1 で「今動いている LOW を止めて HIGH を先に走らせる」ことは、この修正より大きなアーキテクチャ変更になるため意図的に見送った。
- **P2: アイドル中に `pause()` された stem queue が、次に始まるジョブに反映されなかった** — `pump()` が新しいジョブの開始時に無条件で `paused`/`stoppedAt`/`underrunSince` をリセットしていたため、「ジョブが動いていない間に届いた pause 信号」が次のジョブの開始と同時に握りつぶされていた。`underrunSources`（pause の理由を保持する Set）が空でない場合は、新しいジョブは最初から paused 状態で始まる（`register()` は `paused===true` の時点で spawn された子プロセスを即 SIGSTOP する、既存の挙動をそのまま利用）ように変更。
- **P2: mixer の生の underrun イベントが stem queue の即時 `pause()` に直結していた** — 一瞬のアンダーラン数回で `pauseCount` が `MAX_PAUSES` を超えて長時間実行中の Demucs ジョブが kill されてしまう問題。realtime queue 側と同じ debounce 付き `noteUnderrun()`/`noteUnderrunCleared()` 経由に統一した（`pause()`/`resume()` は明示的コマンドとして引き続き公開されたまま、今回の自動配線からは外した）。
- **P1: 通常の再生停止経路で、このプレイヤーの pause source が stem queue に残り続けることがあった** — `stop()` からしか `#stemQ().resume(this)` を呼んでいなかったが、`#onDisconnect()` を直接呼ぶ経路（キュー枯渇でハンドラ未設定など）や、`MixStream.dropCurrent()`（`underrunClear` を発火しない）を経由する4箇所（audioPlayer の `'error'`、mixStream の `'sourceerror'`、`skip()`、watchdog のストール検知）が未カバーだった。新設の `#disconnect()` ラッパー（既存の全 `#onDisconnect()` 呼び出し箇所をこれに置換）と、4箇所の `dropCurrent()` 直後への明示的な `noteUnderrunCleared(this)` 追加で解消。
- **P2: stem queue 自身に kill された HIGH 分離ジョブが、恒久的な失敗として扱われていた** — `#scheduleAnalysis()` 内の realtime job 自身の `ANALYSIS_KILLED` は外側の `.catch()` で1回だけ再試行する既存ロジックがあったが、realtime job は分離を dispatch した時点で即 resolve する（await しない設計、上記参照）ため、stem queue 側で **後から** kill された場合はその外側 catch を素通りしてしまい、再試行が一切効かなかった。同じ「videoId ごとに1回だけ」の bound を共有する形で、stem queue 側の reject ハンドラにも同型の再試行を追加。

round 2 で見つかった追加の1件（P2）:

- **P2: 上記の stem-queue-level kill 再試行が、既に削除済みかもしれない `filePath` から再ステージしようとしていた** — 初回実装は `this.#scheduleAnalysis(track, filePath)` を再度呼ぶことで再試行していたが、stem queue は今やこのジョブを独立に何分も保持しうるため、再試行の時点で `filePath`（正規化済み元ファイル）はトラックの昇格/終了に伴う既存クリーンアップで既に削除されている可能性がある（`stageTempFileCopyFn` からの ENOENT で再ステージが失敗し、次の遷移のための stem を永久に失う）。修正: `#scheduleAnalysis()` を再度呼ぶのではなく、既にディスク上にある `stagedPath`（今回の kill された試行がまさに使っていたもの）を再利用する再帰的な `runSeparation()` ヘルパーに変更。`stagedPath` の cleanup と `#scheduledAnalysisTokens` の解放は、初回・再試行を含む全ての試行が完全に完了してから一度だけ行うようにした。

### 完了条件（§5.5/§17 9C 相当）

- [x] `RealtimeAnalysisQueue`（`getAnalysisQueue()`、無変更）と `StemPreparationQueue`（`getStemPreparationQueue()`、新規）が独立したシングルトンとして存在する
- [x] `StemPreparationQueue` の concurrency は 1（`createAnalysisQueue()` の既存のシリアル FIFO 実装をそのまま利用）
- [x] `StemQueue.pause()`/`resume()`（§5.4）が実装され、realtime queue の underrun イベントから連動して呼ばれる（自動 CPU 監視トリガーは対象外、上記未決事項参照)
- [x] Phase 8 の outgoing-track 分離（`#scheduleAnalysis()`）と Phase 9B の next/next+1 分離（同経路 + `#runLowPriorityStemPrefetch()`）が両方とも `StemPreparationQueue` 経由になった。BPM/downbeat/phrase/key/vocal-activity は `RealtimeAnalysisQueue` のまま
- [x] `StemPreparationQueue` 内で HIGH（B）が pending な LOW（C）より先に dispatch される（Codex レビュー round 1、上記「追記」参照）。既に実行中のジョブへの真のプリエンプションのみ対象外（意図的なスコープ限定）
- [x] 既存の dedup（`#scheduledAnalysisTokens`）・underrun pause/kill・nice-level spawn は両キューインスタンスで維持（`createAnalysisQueue()` 自体を変更せず、2 個目のインスタンスとして再利用したため自動的に満たされる）
- [x] どのトラックが解析/分離されるか、いつされるか、どの transition mode が選ばれるかは無変更（rebase 後の最終計測: `bun run test:server` で Phase 6-9B の既存テストが1件も変わらず通過、711件中703件 pass / 4件 fail は ffmpeg 未インストールによる既知の `silenceTrim.test.js` の失敗のみ、4件 skip も既知）
- [ ] 「Demucs実行中でもBPM/phrase解析がブロックされない」の実音源・実運用計測（構造的な検証は完了、上記未決事項参照）
- [ ] 「incoming stem cache hit rate >= 90%」の実測（上記未決事項参照、Phase 9B から持ち越しの既知の制約）

## 実装ノート (Phase 9D)

§6 の Candidate Ranker を実装した。§6.1 の waterfall（`planBeatSyncedTransition()` が beatmix→phrase-crossfade→legacy の順に評価し、tier 1 が eligible ならその場で return — tier 2/3 は評価すらされない。stem-mix は `player.js` 側で「beatmix が勝たなかった場合のみ」試す bolt-on）を、§6.2 が求める「4 モードすべてを独立候補として評価し、Candidate Ranker が勝者を選ぶ」形に置き換えた。

### 実装箇所

- `src/audio/beatmixTransition.js`:
  - `planBeatmixTransition()` の eligible な返り値に `quality`（§6.3 の6項目オブジェクト）を追加した。既存の `scoreTransitionPairDetail()`（Phase 9D 前段の commit 39bf91d で既に抽出済み）を勝者の exit/entry ペアに対して1回だけ追加で呼び出すだけで、探索ループ自体（`scoreTransitionPair()` を使った比較）は変更していない。
  - `planPhraseCrossfade()` にも同様に `quality` を追加した。ただし tier 2 はテンポ同期もダウンビートグリッドも harmonic 判定も一切行わないため、`tempoCompatibility`/`downbeatConfidence`/`harmonicCompatibility` は（§6.3 の `harmonicCompatibility` が既に確立していた原則どおり）`0` ではなく `null` にしている — 「評価して低かった」と「評価自体をしていない」を区別するため。`vocalSafety`/`energyContinuity` は beatmix と同じ式を、tier 2 が選んだ実際の exit/entry ペアに対して計算している。
  - `planBeatSyncedTransition()`（§16 waterfall 本体）自体は**完全に無変更** — 関数もその既存テスト（`beatmixTransition.test.js` の waterfall セクション）もそのまま残した。`player.js` がこの関数を呼ばなくなっただけで、単体の正しい waterfall プランナーとしては引き続き存在する。理由: 既存テストの「tier 1 が勝てば tier 2 は評価しない」という waterfall 前提のアサーションを、意味のない形で壊さないため。
- `src/audio/transitionCandidates.js`（新規）: Candidate Ranker 本体。
  - `transitionModeBonus(mode)`: §6.4 の表をそのまま実装（stem-mix +0.10 / beatmix +0.05 / phrase-crossfade +0.02 / それ以外 0）。
  - `rankTransitionCandidates(outgoing, incoming, options)`: `planBeatmixTransition()` / `planPhraseCrossfade()` / `planStemTransitionFn()`（デフォルトは `planStemTransition()`、`player.js` の `#planStemTransitionFn` DI と同じ差し替え口）/ `planTransition()`（legacy）を**それぞれ独立に**呼ぶ。stem-mix だけは呼び出し元が渡す `stemsAvailable`（両側のキャッシュ hit を確認済みかどうか）でゲートする — ネットワーク/ディスクを叩くキャッシュ確認自体は非同期なので、この関数は Phase 7C の `planBeatSyncedTransition()` と同じく同期のままにし、キャッシュ確認は呼び出し元（`player.js`）の責務として残した。beatmix/stem-mix/phrase-crossfade の3つを `score + transitionModeBonus(mode)` の argmax で比較し、勝者を `selectedPlan` として返す。
  - legacy（`planTransition()`）は§6.2 の図には候補として描かれているが、**スコアでは競合させていない** — legacy には beatmix/stem-mix/phrase-crossfade のような品質モデルがなく（`confidence` は単に `outgoing.confidence` の生値で、遷移の相性スコアではない）、これを他の3つと同じ土俵でスコア比較すると、無関係に高い `confidence` を持つ legacy が本来 beatmix 等が選ばれるべき場面で誤って勝ってしまうリスクがある。beatmix/stem-mix/phrase-crossfade が1つも eligible でない場合にのみ legacy を選ぶ、という Phase 9D 以前の waterfall の最下段の挙動をそのまま保持している（意図的なスコープ判断 — 下記「未決事項」参照）。
  - `bestNonStemPlan`: stem-mix を除いた3候補（beatmix/phrase-crossfade/legacy）だけで同じ argmax を行った結果も一緒に返す。stem-mix の exitStartSec/entrySec は vocal-safety を緩和して選ばれている（stem 別のフェード envelope があって初めて安全）ため、TRACK ループ再選択で stem-mix が使えなくなった場合の再プランは、stem-mix 自身の window を流用せずこちらから行う必要がある（§8 由来の既存制約、下記参照）。
- `src/audio/transitionLog.js`: `buildTransitionPlanReport()` のシグネチャを `rawPlan`/`stemPlan` から `candidates`（`rankTransitionCandidates()` の `candidates.beatmix`/`.stemMix`/`.phraseCrossfade`、§6.3 Candidate 構造そのもの）+ `selectedPlan` に変更した。従来 `barredCandidate()`/`phraseCandidate()` が担っていた「waterfall のどの段まで評価が進んだか」の推測（`rawPlan.mode === 'beatmix'` なら tier 2/stem-mix は `not-evaluated-beatmix-selected`）は完全に不要になった — 各候補は独立評価の結果を **常に** 直接持っているため、単純に整形するだけの `candidateToReportShape()` に置き換えている。`not-evaluated-*` の reason は「stem-mix のキャッシュ確認自体が走らなかった」ケース（`#stemMixUnavailableKey` によるスキップ、または `mightBeatmix` 前提チェックで最初から不可能と分かっている場合）専用の `not-evaluated-stem-mix-unavailable` 1本に統合した。
- `src/player.js` `#maybeStartCrossfade()`:
  - `planBeatSyncedTransition()` の呼び出しを `rankTransitionCandidates()` に置き換えた。
  - stem キャッシュの確認（`getCachedStemsFn()`）を、従来の「`rawPlan.mode !== 'beatmix'`（＝ beatmix が勝っていない）」というゲートから外し、「`mightBeatmix`（＝そもそも両側に BPM がある）かつ `#stemMixUnavailableKey` に一致しない」というゲートに変更した。beatmix が eligible かどうかに関わらず常に確認する（§6.2 の独立評価の要請どおり）が、BPM が無く beatmix/stem-mix のどちらも原理的に成立し得ないことが既に分かっている pair では、200ms ごとの arm tick で無駄な fs アクセスを繰り返さないよう従来どおりスキップする（純粋なパフォーマンス最適化で、独立評価の意味論には影響しない）。
  - TRACK ループ再選択（`next === current`）で stem-mix プランを捨てて再プランする箇所は、従来の `rawPlan`（waterfall の非 stem-mix 結果）の代わりに `rankTransitionCandidates()` が返す `bestNonStemPlan` を使うよう変更した。
  - それ以外（prepDue/readyToFade のゲート、`forcePlainCrossfade` によるダウングレード、`#stemMixUnavailableKey` の設定箇所など）は無変更。
- テスト:
  - `src/audio/transitionLog.test.js`: `buildTransitionPlanReport()` の新シグネチャに合わせて全面的に書き直した。「beatmix が勝ったので phrase-crossfade/stem-mix は not-evaluated」という waterfall 前提のテストは、「phrase-crossfade は独立評価されて real reject reason を返す」「stem-mix はキャッシュ未確認なら not-evaluated-stem-mix-unavailable」というテストに置き換えている。アサーションの意味そのもの（HIT/MISS の扱い、vocalActive の判定、legacy exit のフォールバック計算など）は変更していない。
  - `src/audio/beatmixTransition.js`/`src/audio/stemTransition.js` の既存テストは無変更のまま全件パス（`quality` フィールドの追加は既存の `deepEqual` アサーションと衝突しない — reject 系のテストは `plan.reasons` の部分一致のみを見ており、eligible 系のテストは個別フィールドの `assert.equal` のみで全体 `deepEqual` を使っていないことを確認済み）。
  - `src/player.acceptance.test.js` は無変更。Phase 8 由来の stem-mix 系テスト（`stemFixtures()` を使うもの全て）は、フィクスチャの outgoing 側 exit 候補が意図的に vocal 区間の途中にあり、beatmix 側の `requireExitVocalSafe` を素で満たせないよう作られている — 独立評価に変えても beatmix は真に ineligible のままなので、stem-mix が勝つという既存の期待どおりの結果になる。beatmix と stem-mix が両方 eligible になる（かつ stem preference bonus の実際の勝敗が試される）フィクスチャは既存テストに存在しないことをコードリーディングで確認した。

### 未決事項 / 既知の制約

- **legacy はスコア競合の対象外**: 上述のとおり、legacy（`planTransition()`）は §6.2 の図には4番目の候補として描かれているが、実装では「beatmix/stem-mix/phrase-crossfade が1つも eligible でないときのみ選ばれる」という waterfall 最下段のセマンティクスのまま据え置いた。理由は上記「実装箇所」参照。将来的に legacy にも意味のある品質モデル（例えば `outgoing.confidence` ではなく実際の遷移相性を反映したスコア）を与えられるなら、`transitionModeBonus()` の `default: 0` と合わせて4候補を完全に対等競合させることもできるはずだが、これは Phase 9D のスコープ外と判断した。
- ~~stem preference bonus (§6.4) を実際に検証する新規フィクスチャは追加していない~~ → 下記「追記: Codex レビュー対応（PR #46, round 2）」で `src/audio/transitionCandidates.test.js` に実際の分析値によるフィクスチャを追加し、beatmix/stem-mix/phrase-crossfade 間のタイブレークが数値どおりに機能することを検証した。
- **`mightBeatmix` ゲートは stem-mix の独立評価をわずかに妥協している**: 純粋な §6.2 の要請どおりなら、beatmix が原理的に不可能な pair でも stem-mix のキャッシュ確認自体は独立に行うべきだが、BPM が無ければ `planStemTransition()`（内部で `planBeatmixTransition()` の BPM ゲートを再利用している）も必ず reject するため、確認しても意味がない。200ms ごとの arm tick で無駄な fs アクセスを避けるための意図的な最適化であり、実際の eligibility 判定結果には影響しない。
- **実測評価は未実施**: Phase 9A/9B/9C のノートが繰り返し書いている制約と同じく、stem preference bonus が実際の楽曲でどの程度 stem-mix を選ばせるようになるか（そしてそれが聴感上望ましいか）は実音源・実運用での確認が必要で、本エージェント環境では実施できない。

### 完了条件（§6 相当）

- [x] beatmix / stem-mix / phrase-crossfade が独立候補として評価される（一方が eligible でも他方の評価をスキップしない）
- [x] Candidate 構造（§6.3: `mode`/`eligible`/`score`/`quality`/`fadeSec`/`bars`）を実装し、`quality` の6項目（`phraseAlignment`/`tempoCompatibility`/`vocalSafety`/`downbeatConfidence`/`harmonicCompatibility`/`energyContinuity`）を各モードから返す
- [x] `transitionModeBonus()`（§6.4）を実装し、`rankTransitionCandidates()` のスコア比較に適用した
- [x] stem preference: stem-mix と beatmix が両方 eligible な場合、bonus によりタイ・僅差では stem-mix が優先され、品質差が大きい場合は beatmix が選ばれ得る（argmax(`score + bonus`) の自然な帰結。上記未決事項のとおり、この具体的なタイブレーク挙動を検証する専用テストは未追加）
- [x] `[MIX PLAN]` レポート（§3.2）が独立評価を正しく反映する（beatmix が勝っても phrase-crossfade/stem-mix は実際の評価結果を報告する。stem-mix が「未評価」なのは、キャッシュ未確認 or BPM無しで原理的に不可能な場合のみ）
- [x] 既存の Phase 7-9C の挙動が変わっていないことをテストで確認: `bun run test:server` で 729件中 721 pass / 4 fail（`silenceTrim.test.js` の ffmpeg 未インストールによる既知の失敗のみ、Phase 9A/9B/9C のノートに書かれているものと同一）/ 4 skip
- [ ] stem preference bonus の実運用での聴感評価（上記未決事項参照）

### 追記: Codex レビュー対応（PR #46, round 2）

初回実装後の Codex レビューで、§6.4 のスコア比較そのものに関わる実バグ2件が見つかった。いずれも「あるモードのスコアが、他モードと同じ土俵で比較できない形で計算されている」という同じ種類の問題で、`transitionModeBonus()` の小さな差分（+0.10/+0.05/+0.02）と組み合わさることで、本来品質で劣るはずの候補が誤って勝ってしまっていた。

- **P2: stem-mix のスコアが常に beatmix 以上になり、事実上負けられない**（`comparableStemMixConfidence()` による最初の修正 → さらに round 2 で修正）
  - 1回目の指摘: `planStemTransition()` は `vocalSafety` を relaxed（exit 側を評価対象から外す、`stemAware: true`）に計算するため、同じペアなら relaxed スコアは strict スコア以上にしかならない。beatmix の strict スコアと直接比較すると、stem-mix 側の +0.10 bonus（beatmix は +0.05）と合わさって「stem-mix の品質が明らかに劣る場合は beatmix を選ぶ」という §6.4 の除外規定が実質的に到達不能になっていた。最初の修正として `comparableStemMixConfidence()`（`transitionCandidates.js` の ranking 直前に適用する post-hoc 補正）を追加したが、これはレビューで round 2 の指摘を受けた:
  - 2回目の指摘: post-hoc 補正は `planStemTransition()`（内部で `planBeatmixTransition({stemAware:true, ...})` を呼ぶ）が **relaxed スコアで exit/entry ペアの探索を既に終えたあと** の、生き残った1個のペアにしか適用できない。relaxed 探索が「エネルギー的には良いが深く vocal 中の exit」を先に選んでしまっていた場合、strict スコアなら勝っていたはずの「vocal-safe な別の exit」は探索の時点で既に捨てられており、post-hoc 補正では復元できない。
  - 根本修正: `planBeatmixTransition()` の探索ループ自体（`pairScore` の計算、`beatmixTransition.js`）を、`stemAware` の値に関わらず常に strict スコア（`scoreTransitionPair({ ..., stemAware: false })`）でランキングするよう変更した。`stemAware: true`（`requireExitVocalSafe: false` 経由）は引き続き「mid-vocal な exit を候補として許可する」役割のみを担い、「その候補たちの中でどれが最良か」の判定は strict スコアで行う。結果として、vocal-safe な exit が候補に存在すればそちらが自然に選ばれ、mid-vocal な exit しか無い場合のみ（そしてその場合に限り）そちらが選ばれる。この修正により `planStemTransition()`/`planBeatmixTransition()` が返す `confidence` 自体が既に cross-mode で比較可能になったため、`comparableStemMixConfidence()` とその `transitionCandidates.js` 側の呼び出しは削除した（もはや不要かつ、二重補正になり誤った値を返すリスクがあった）。最終的な `quality.vocalSafety`（レポート用、relaxed のまま）は変更していない — stem-mix 自身の「per-stem envelope があるので実際には安全」という主張はそのまま保持している。
  - テスト: `beatmixTransition.test.js` に、mid-vocal だが高い phrase score を持つ exit と、vocal-safe だが低い phrase score の exit の両方を候補として与え、strict ランキングが後者を選ぶことを確認するテストを追加した（探索ロジック自体の修正を直接検証）。修正を一時的に revert すると期待どおり前者が選ばれ、修正で失敗が再現することを確認済み。
- **P2: phrase-crossfade のスコアが beatmix の tempo/downbeat ペナルティを回避できてしまう**
  - 指摘: `planPhraseCrossfade()` の `confidence` は `phraseAlignment` 単独（tier 2 はテンポ同期もダウンビートグリッドも一切評価しない）。beatmix の6項目加重平均と直接比較すると、テンポが全く同期していない phrase-crossfade でも `phraseAlignment: 1`（きれいなフレーズ境界が見つかっただけ）で `confidence: 1` になり得る一方、実際には強くテンポ同期できている beatmix が `tempoCompatibility`/`downbeatConfidence` 項の加重平均で 1 未満に収まる分だけ不利になり、beatmix の bonus（+0.05）を足しても phrase-crossfade の bonus（+0.02）付きスコアに負けることがあった。
  - 修正: `comparablePhraseCrossfadeConfidence()`（`beatmixTransition.js`）を追加した。stem-mix の場合と異なり、こちらは探索ループ自体を直す必要がない（tier 2 の候補探索は元々 `phraseAlignment` のみで比較しており、tempo/downbeat 項は最初から存在しないため「別の候補を先に捨ててしまう」問題は起きない）ので、`transitionCandidates.js` 側の ranking 直前で post-hoc 補正するだけで十分。`scoreTransitionPairDetail()` と同じ加重式を使い、`vocalSafety`/`phraseAlignment`/`energyContinuity` は実際の値を、`tempoCompatibility`/`downbeatConfidence` は（項自体を加重平均の分母から除外するのではなく）明示的に `0` として計算する — 除外すると「同期していないことを評価しない」＝今回のバグの再現になってしまうため、必ず加算対象に含めた上でゼロ点を与える必要がある。
  - テスト: `comparablePhraseCrossfadeConfidence()` の単体テストに加え、`transitionCandidates.test.js` に実際の分析値（`bpm: 120` vs `124`、`downbeatConfidence` 0.5前後）による beatmix/phrase-crossfade 両方 eligible なフィクスチャを追加し、修正前は phrase-crossfade（rank 1.02）が beatmix（rank 0.822）に勝ってしまうこと、修正後は beatmix が正しく勝つこと（phrase-crossfade の補正後 rank は約0.591）を確認した。逆に、beatmix が原理的に ineligible（incoming 側に BPM が無い）な場合は phrase-crossfade がそのまま勝つことも別テストで確認し、「常に beatmix を優先するだけの修正になっていないか」を検証した。
- 上記2件を踏まえ `src/audio/transitionCandidates.js` の `toCandidate()` は `scoreOverride` 引数を維持しつつ、適用先を stem-mix から phrase-crossfade に切り替えた（stem-mix は探索側の修正で不要になったため）。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #46, round 3）

round 2 の `comparablePhraseCrossfadeConfidence()`（post-hoc 補正）は、stem-mix の round 2 修正と全く同じ構造上の欠陥を持っていた — `planPhraseCrossfade()` 自身の候補探索が既に raw `phraseAlignment` だけでペアを選び終えたあとにしか補正を適用できず、探索時点で「vocal-safety margin は薄いが phraseAlignment は高い」ペアが「margin は十分だが phraseAlignment はやや低い」より良いペアを既に捨ててしまっていた場合、補正はそれを救えなかった。

- **P2: phrase-crossfade もペア探索自体で比較可能スコアを使うべき** — stem-mix の round 2 根本修正（探索ループ自体を strict スコアでランキング）と同じアプローチを適用した。`planPhraseCrossfade()` の候補探索ループを、raw `phraseAlignment` ではなく `comparablePhraseCrossfadeConfidence()` と同じ加重式（vocalSafety/phraseAlignment/energyContinuity、tempoCompatibility/downbeatConfidence はゼロ点）で各ペアをランキングするよう変更した。これにより勝者ペア自身の `confidence` が既に cross-mode で比較可能な値になったため、`comparablePhraseCrossfadeConfidence()` 関数と `transitionCandidates.js` 側の `scoreOverride` 呼び出しは完全に不要になり削除した（`toCandidate()` の `scoreOverride` パラメータ自体も削除 — stem-mix・phrase-crossfade どちらの post-hoc 補正も今は探索側の修正で不要になったため）。
  - テスト: `beatmixTransition.test.js` に、vocal境界ぎりぎり（margin ほぼ0）だが phraseAlignment が高いペアと、margin は十分だが phraseAlignment がやや低いペアの両方を候補として与え、比較可能スコアでのランキングが後者を選ぶことを確認するテストを追加した。
- 併せて、PR #46 のスコア較正修正で唯一残っていた未対応の指摘（"Preserve the non-stem fallback until stem prep commits" — take 時に stem prep が間に合わなかった場合、`bestNonStemPlan` へフォールバックせずこの試行全体を中断してしまう問題）は、根本的な修正が `player.js` の take-time commit パスへの実質的な改修（`bestNonStemPlan` 用の代替ソースを投機的に準備する、または take-time の abort 箇所でその場で `bestNonStemPlan` から再プランして即座にフォールバックする、のいずれか）を要するアーキテクチャ上のより大きな変更と判断し、このセッションでは対応を保留し、診断結果と2つの対応方針候補を PR コメントで提示した。
- **P2: 部分的な stem-cache hit がメモ化されなかった** — `#stemCacheHit` は current/next の**両方**が hit した場合にのみメモ化されていたため、片側（多くは outgoing）が既にキャッシュ済みでもう片側の分離がまだ進行中、という頻出する過渡状態では毎回（約200msごとの arm tick ごとに）両方を再確認していた — `getCachedStems()` は読み取り専用ではなく `utimes()` で LRU の mtime を更新するため、無駄な fs アクセスが積み重なる。`#stemCacheHit` を `#outStemCacheHit`/`#inStemCacheHit` の2つに分割し、それぞれ自分のトラック識別子だけをキーにして独立にメモ化するよう変更した — 既に hit している側はどの `next` と組み合わされていても再利用され、まだ miss の側だけが毎 tick 再確認される。

### 追記: Codex レビュー対応（PR #46, round 4）

round 3 の `#outStemCacheHit`/`#inStemCacheHit`（片側ごとの独立メモ化）に、round 3 のマージ後さらに1件の指摘が見つかった。

- **P2: 部分的な hit がメモ化されたまま失効を検知できない** — round 3 修正は、片側（多くは outgoing）が既に hit してメモ化されている間、もう片側の分離が完了するまで何十ティックも `getCachedStemsFn()` を呼ばずに済ませる設計だった。しかし `pruneStemCache()` はバックグラウンドでいつでもエントリを evict しうるため、メモ化された側のファイルがその間に消えても、もう片側が hit した瞬間にそのまま「両方揃った」と判定してしまう（stale なメモを一度も再検証しない）。これにより、実際にはもう存在しない stem ペアを `stemsAvailable: true` として ranker に渡してしまい、まだ準備できていた beatmix 等の候補を stem-mix が上書きしてしまう——そして stem-mix 自身も `#ensureOutgoingStemPrep()`/`#ensureIncomingStemPrep()` 側の prep-time revalidation で初めて失敗に気づくため、その時点では手遅れ（take-time abort パスに落ちる）。
  - 修正: 「もう片側がちょうどこのティックで hit に転じた」瞬間（`needIn && !needOut` またはその逆）にのみ、メモ化されていた側を1回だけ再検証するようにした。まだ両方待ち状態のティック（もう片側がまだ missing のまま）や、両方とも既にメモ化済みの定常状態（外側の `needOut || needIn` チェックがそもそも false になり、このブロック全体がスキップされる）には影響しない——メモ化本来の目的（片側 hit 中の毎ティック fs アクセスを避けること）を損なわずに、新規に導入されたステイル判定ウィンドウだけを閉じている。
  - テスト: outgoing 側は最初の呼び出しのみ hit・以降は毎回 miss（バックグラウンド eviction を模擬）、incoming 側は最初の数ティックは miss・その後 hit に転じるフィクスチャを用意し、incoming が hit した後もステム専用ソース（`createFileSourceFn`）が一度も spawn されないこと、また最終的に選ばれた遷移モードが `stem-mix` にならないことを確認するテストを追加した。修正を revert すると、期待どおりステム専用ソースが 2 件 spawn される（stale なメモを信じて stem-mix にコミットしてしまう）ことを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #46, round 5）

round 4 のプッシュ後、さらに2件の実バグが見つかった。

- **P2: marginal-tempo の信頼度ゲートが常に strict スコアを見ていた** — round 2 の根本修正（`planBeatmixTransition()` の探索を `stemAware` の値に関わらず常に strict スコアでランキングする）以降、`isMarginalTempo && best.pairScore < MARGINAL_TEMPO_MIN_SCORE` の判定も同じ strict `pairScore` を再利用していた。しかし stem-mix 候補にとって、mid-vocal な exit の strict vocalSafety はゼロになりうる——それこそが stem separation が安全にする対象そのものであり、relaxed（`stemAware: true`）スコアなら閾値をクリアする場合がある。修正: marginal-tempo の適格性判定だけ、`stemAware` が true のときは同じペアを `stemAware: true` で再スコアリングした値を使うようにした（どのペアが勝つか自体は引き続き strict スコアで決まる）。
  - テスト: 深く mid-vocal な exit（strict score ~0.53、閾値0.7未満）だが relaxed score は ~0.768（閾値クリア）というフィクスチャで、`stemAware: true` 呼び出しが `eligible: true` になることを確認するテストを追加した。数値は `scoreTransitionPairDetailed()` を直接呼ぶデバッグスクリプトで実測して較正した。
- **P2: TRACK loop のエントリーリセットが phrase-crossfade の baseSwap/EQ を剥がしていなかった** — TRACK loop（`next === current`）がエントリーを強制的に 0 へリセットする際、`norm.mixPlan.mode === 'beatmix'` のときだけ `baseSwap`/`sync`/`eq` を剥がしていた。Phase 9D の独立ランカー以降、beatmix が原理的に ineligible（例: BPM データなし）でも phrase-crossfade 単独で勝つケースがあり、そのケースでは元々選択されたフレーズ境界向けの `baseSwap: true`/EQ がそのまま、実際にはエントリー0（曲の先頭）から再生される音声に適用されてしまっていた。修正: `normalizeTransitionPlan()` を呼ぶたびに、どの raw plan（`selectedPlan` か、stem-mix 降格時の `bestNonStemPlan`）が現在 `norm` に反映されているかを `normRawMode` として追跡し、`norm.mixPlan.mode === 'beatmix' || normRawMode === 'phrase-crossfade'` のときに剥がすよう拡張した。
  - テスト: BPM データなし（beatmix が bpm-unavailable で ineligible、phrase-crossfade のみが候補）のフィクスチャで TRACK loop を有効にし、`planBeatSyncedTransition()` の raw plan が実際に `phrase-crossfade`（`baseSwap: true`、エントリーは非ゼロ）であることをテスト不変条件として確認した上で、実際の TRACK loop 再生後に `startedPlan.baseSwap === false` になることを確認するテストを追加した。修正を revert すると `baseSwap` が `true` のまま漏れることを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。
