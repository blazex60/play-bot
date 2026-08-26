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

### 追記: Codex レビュー対応（PR #44, round 2）

- **P1: LOW プリフェッチの duration probe が pause/kill 機構から漏れていた** — `trimSilence()`（`src/normalize.js`）の `probeDurationFn`（`duration.js` の `probeDurationSec()`）は、`spawnFn` を差し替えても常にモジュールレベルの `spawn` 経由で ffprobe を起動しており、queue の pause/kill 機構の対象外だった。`probeSpawnFn`（raw ChildProcess を返す override）を追加し、`prefetchTrack()` → `trimSilence()` まで貫通させた。abort が probe 実行中に届いた場合、probe 自体は最後まで走るが、その直後の signal チェックで次のステップ（silencedetect の ffmpeg 呼び出し）に進むのを止める。

### 追記: Codex レビュー対応（PR #44, round 3）

- **P1: 2回目の duration probe の前に abort チェックが無かった** — `trimSilence()` の atrim/re-encode ステップ後、`access(outPath)` → `probeDurationFn(outPath, ...)`（2回目の ffprobe 呼び出し）→ `throwIfAborted(signal)` という順序だったため、`access()` が pending の間に abort が届いても、2回目の probe（新しい ffprobe サブプロセス）がそのまま起動してしまっていた。signal のチェックは probe の**後**にしかなく、その時点で analysis queue が既に次のジョブへ進んでいれば、この probe は次のジョブの子プロセスとして誤って登録され、まさに abort が緩和しようとしていた再生負荷の最中にリソースを消費し続けるおそれがあった。`access(outPath)` の直後、2回目の `probeDurationFn()` 呼び出しの**前**に `throwIfAborted(signal)` を追加し、1回目の probe（`beforeSec`）と同じパターンに揃えた。
- **P2: `StemPrefetchTracker` の READY が sticky すぎて、キャッシュ失効を検知できなかった** — `pruneStemCache()`（`src/audio/stemCache.js`）は共有キャッシュがサイズ上限を超えると古いエントリを LRU で追い出すが、これは他ギルドの分離処理が引き金になることもあり、`#ensureStemPrefetch()` の呼び出し元には一切通知されない。従来は `entry.state === READY` なら `getCachedStemsFn()` のプローブ自体を早期 return でスキップしていたため、next/next+1 のウィンドウにまだ滞在中のペアが裏で追い出されても、トラッカーは READY を報告し続け、二度と再分離がディスパッチされなかった（実際の遷移経路自体は take 時に `access()` で再検証してフォールバックするため再生は壊れないが、このプリフェッチ状態表示だけが永久に stale になる）。早期 return を削除し、READY のエントリも MISS のエントリと同じように毎回 `getCachedStemsFn()` で再確認するよう変更した — HIT なら READY を再確認するだけ（no-op）、MISS なら既存の HIGH/LOW 再ディスパッチ経路にそのまま入る。
  - テストのために `#prefetchUpcoming()` を二度目に呼ぶ具体的な trigger（プロダクションでの実際のトリガーは何であれ、`queue.upcoming()` の中身が変わらないまま同じチェックポイントが再実行されるケース全般を代表する）として、`playNext()` をキューを一切進めずに再度呼ぶ手法を使った。HIGH（next）に昇格するトリガー（skip）は使わなかった — 昇格させると Phase 8 の `#ensureFullPrefetch()`/`#scheduleAnalysis()` パイプラインが（このトラッカーのロジックとは無関係に）独自に `separateTrackStemsFn()` を呼んでしまい、修正の有無に関わらずテストが通ってしまう（実際に一度この汚染に気づかず誤って green なテストを書いてしまった — `separateCallsForC` だけを見て「修正が効いた」と誤認しかけたが、fix を revert しても同じテストが通ることに気づいて設計をやり直した）。

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

## 実装ノート (Phase 9E)

§7 の Long Mix Zone（4/8/16 bars）を実装した。beatmix/stem-mix のバー数探索を「preferred=4 bars 固定、足りなければ minimum=2 bars へフォールバック」という Phase 7C 以来の二段構成から、§7.2 の「16 → 8 → 4 → fallback」の三段構成に拡張し、最上段（16 bars = extended tier）は stem-mix かつ両側の解析信頼度が高いペアだけに許可した。

### 実装箇所

- `src/audio/beatmixTransition.js`:
  - `MIX_BARS = { preferred: 8, minimum: 4, extended: 16 }`（§7.2 そのまま）を新設し、既存の `BEATMIX_OVERLAP_BARS`/`MIN_OVERLAP_BARS` はこのオブジェクトの `preferred`/`minimum` を指すエイリアスに変更した。両定数は `src/mix/ordering.js`（`transitionCost()` の beatmix 項）や、この2ファイル自身の複数のテストから名前で import されているため、値だけを差し替えてエクスポート名は維持している。
  - `preferred` を 4→8 bars、`minimum` を 2→4 bars に引き上げた（§7.2 の新設定そのもの）。`extended`（16 bars）は完全に新規。
  - `extendedTierEligible(outgoing, incoming, stemAware)`（新規、非公開関数）: §7.2 の3条件「phrase confidence high / stem available / vocal plan usable」を、既存のこのコードベースの解析フィールドにマップした:
    - **stem available** = 呼び出し元が渡す `stemAware` フラグそのもの。`planBeatmixTransition()` は `planStemTransition()`（`stemTransition.js`）から呼ばれるときだけ `stemAware: true` を渡し、その呼び出し元（`player.js`/`transitionCandidates.js`）は両側のキャッシュ済み stem の存在を既に確認済み、という既存の契約をそのまま利用している——`extendedTierEligible()` 自身はキャッシュを再確認しない。プレーンな（非 stem）beatmix 呼び出しは `stemAware` を渡さないため、16 bars の単一ストリームクロスフェード（両トラックのボーカルが overlap 全体で重なる）が生まれることはない——これは per-stem ボーカルエンベロープ（`buildStemEnvelopes()`）が防ごうとしている失敗パターンそのものなので、意図的な設計。
    - **phrase confidence high** = 両側の `downbeatGrid.confidence >= EXTENDED_PHRASE_CONFIDENCE_MIN`（新設: `0.7`）。この 0.7 は、既存の `DOWNBEAT_CONFIDENCE_MIN`（0.4、bar-1 の eligibility floor）を「単に通過した」水準ではなく「§8.3 の marginal-tempo tier が要求する `MARGINAL_TEMPO_MIN_SCORE`（同じく 0.7）」と揃えた、「non-default tier に見合う高信頼度」という同ファイル内の既存の前例を再利用した値。
    - **vocal plan usable** = 両側の `vocalConfidence >= EXTENDED_VOCAL_CONFIDENCE_MIN`（新設: `0.85`）。`vocalActivity.js` の `classifyVocalEnvelope()` が最上位の 0.85 を返すのは RMS フレームが十分（5フレーム以上）分類できたときのみ——`hasVocalAnalysis()`（既存、`analysisSource !== 'none'` のみを見る）より厳しい、「薄いが本物の読み取り」と「十分にサンプリングされた読み取り」を区別するゲート。
  - `planBeatmixTransition()` のバー数探索ループ: 従来は `overlapBars`（=preferred）から `minOverlapBars`（=minimum）まで1本のループで降順に試し、最初にフィットしたバー数を採用していた。この形は変えず、開始点だけを `extendedTierEligible(outgoing, incoming, stemAware) ? MIX_BARS.extended : overlapBars` に変更した——§7.2 の「16→8→4→fallback」という名前つき三段は、実装上は 16 (or 8), 15, 14, ..., 4 という単一の降順スイープとして実現されており、extended 非該当のペアは単に 8 から始まるだけで、それ以外のロジック（vocal-safe/forward-safe room チェック、ペアごとのスコアリング）は完全に無変更。
- `src/player.js` `#maybeStartCrossfade()`: `MAX_TRANSITION_LEAD_SEC`（= `TAIL_WINDOW_SEC`、45秒、Phase 9E で無変更）まわりの既存コメントに、16 bars 到達時の制約を追記した——下記「未決事項」参照。ロジック自体の変更はなし。
- テスト:
  - `src/audio/beatmixTransition.test.js`: `MIX_BARS`/`extendedTierEligible()`/16-bars 探索開始点まわりに8件追加（stem-mix + 高信頼度ペアが16 barsを選ぶこと、いずれか一方の条件が欠けると8 barsへ落ちること、非 stem-mix 呼び出しは常に8 bars始まりであること、など）。全件パス。
  - `src/mix/ordering.test.js`: `MIN_OVERLAP_BARS` が 2→4 bars になったことで、`transitionCost()` の beatmix 項が「新しい 4-bar floor をちょうど下回る/ちょうど満たす」ことを検証している3件のフィクスチャの秒数を再較正した（例: 「3.5秒しか room がない」ケースは floor が 4s だった頃の想定のままなので、floor が 8s になった今も変わらず「4s には足りるが8sには足りない」という同じ意味を保つよう `7s room, needs 8s` に更新——アサーションの意味・落ちる/落ちない境界の位置関係は完全に不変、絶対値だけがスケールした）。
  - `src/player.acceptance.test.js`: `MIN_OVERLAP_BARS`/`BEATMIX_OVERLAP_BARS` が伸びたことで、9件の beatmix/stem-mix acceptance テストのフィクスチャが「新しい minimum(8s)/preferred(16s) を満たさない」状態になり fail していた（プレーンな beatmix は `crossfade`/`phrase-crossfade` へ意図せず降格、stem-mix は `no-overlap-fit` で丸ごと ineligible）。9件とも exit/entry 候補の room（`durationSec`/`lastVocalEndSec`/`firstVocalStartSec`/phrase 秒数）を「新しい4-bar floor(8s) はちょうど超えるが5-bar(10s)には届かない」という、この phase 以前と同じ「ぎりぎり minimum 止まり」の形になるよう再較正した。アサーションの中身（spawn 引数、promotion の宛先、`[MIX PLAN]` レポートの形、prep revalidation の挙動、remainingSec の具体値 3.4s など）はどれも変更していない——変えたのは各フィクスチャがどのバー数に着地するかを決める秒数だけ。共有ヘルパー `stemFixtures()`（6件のstem-mixテストが使用）も同様に更新し、他の（元から通っていた）stemFixtures 利用テスト（cache-miss/eviction系）が緩いアサーション（`if (startedPlan) assert.notEqual(...)`）のおかげで影響を受けないことを確認済み。

### §7.2 の探索順との対応

```text
仕様（§7.2）:            実装:
16 bars                  extendedTierEligible() が真のときだけ startBars = 16
  ↓                         ↓ (bars -= 1 の同一ループ内)
8 bars                    それ以外は startBars = 8（= MIX_BARS.preferred）
  ↓                         ↓
4 bars                    ループは MIX_BARS.minimum (4) まで降順に継続
  ↓                         ↓
fallback                  no-overlap-fit → planBeatSyncedTransition()/
                           rankTransitionCandidates() の他候補（phrase-crossfade 等）
```

### 未決事項 / 既知の制約

- **16 bars の到達距離は TAIL_WINDOW_SEC（45秒）を超えうる**: `player.js` の `#maybeStartCrossfade()` が exit 候補を探す tail 解析窓は `TAIL_WINDOW_SEC`（45秒、無変更）で頭打ちになっている。16 bars @ 120 BPM/4-beat は 32秒だが、テンポが遅いほど1バーの秒数は伸びる——例えば 80 BPM/4-beat では 16 bars = 48秒で、45秒の窓を超える。これは二重の意味で効く: (1) `MAX_TRANSITION_LEAD_SEC`(=`TAIL_WINDOW_SEC`) がそのまま prep ゲートの開くタイミングの上限にもなっているため、遅いテンポの16-bar到達点はそもそも「まだ早すぎる」として prep が開かない可能性がある、(2) `findExitCandidates()` 自身が tail 解析窓の外の phrase 境界を最初から知らない——遅いテンポでは「本当は16 bars分のroomがあるのに、そのroomの入口が45秒解析窓の外にあるため exit 候補として見つからない」ケースが起こりうる。これは Phase 9E のスコープ外として意図的に据え置いた既知の制約で、`player.js` の `#maybeStartCrossfade()` 内のコメント（`MAX_TRANSITION_LEAD_SEC` の直上）にも同じ説明を残している。tail 解析窓自体を広げる対応は §8（Phase 9F, Exit Candidate 探索範囲拡張）のスコープ。
  - 実用上の影響度: 16 bars（extended tier）は stem-mix かつ高信頼度ペアのみが対象なので、影響を受けるのは「遅めのテンポ・かつ stem 準備済み・かつ高信頼度」という比較的狭い交差点のみ。8 bars（preferred）・4 bars（minimum）はどちらのテンポでも 45秒の窓に収まる（8 bars は BPM 64 以上、4 bars は BPM 32 以上で収まる計算——通常の楽曲のテンポ域を十分にカバーする）ため、この制約は主に extended tier にのみ及ぶ。
- **実測評価は未実施**: Phase 9A-9D のノートが繰り返し書いている制約と同じく、16 bars の Mix Zone が実際の楽曲・実運用でどれだけ「聴感上心地よいロングミックス」として機能するか（そしてどの程度の割合の遷移が実際に extended tier に到達するか）は実音源・実 Discord セッションでの確認が必要で、本エージェント環境では実施できない。
- **§17 9E の "8 bars以上のMix Zoneが実際に再生される" の検証範囲**: `player.acceptance.test.js` の beatmix/stem-mix テスト（今回再較正した9件を含む）で、8 bars(16s)/4 bars(8s) のバー数で実際に `crossfadestart` イベントが発火し、`MixStream` がそのフレーム数だけ overlap を駆動し、トラックが promotion まで進むこと（＝「プランされるだけでなく実際に再生される」）を構造的に確認済み。16 bars（extended）到達の acceptance レベルでの専用テストは今回追加していない——`beatmixTransition.test.js` 側の8件のユニットテストで `extendedTierEligible()`/開始バー数の選択ロジック自体はカバーしているが、`player.js` の実プレイバック経路（spawn/crossfade/promotion）を16 barsの overlap で最後まで駆動する acceptance テストは未追加。理由: 16 bars @ 120 BPM = 32秒の overlap をフレーム単位（20ms/frame = 1600 reads）で駆動する acceptance テストはこのファイルの実行時間（`player.acceptance.test.js` 単体で最大約45秒程度）をさらに押し上げる割に、実際に検証したいロジック（プランナーの開始バー数選択）は既に `beatmixTransition.test.js` 側でユニットレベルにカバーされているため、今回は見送った。次フェーズ以降で必要になれば追加を推奨する。

### 完了条件（§7/§17 9E 相当）

- [x] `MIX_BARS = { preferred: 8, minimum: 4, extended: 16 }`（§7.2）を実装し、既存の `BEATMIX_OVERLAP_BARS`/`MIN_OVERLAP_BARS` の全呼び出し元（`ordering.js`、両ファイルのテスト）に後方互換のまま反映した
- [x] 探索順「16 → 8 → 4 → fallback」を実装した（`extendedTierEligible()` が startBars を決め、既存の単一降順ループがそれ以降を担う）
- [x] 16 bars tier のゲート（stem-mix / phrase confidence high / vocal plan usable、§7.2）を実装し、`beatmixTransition.test.js` で境界（3条件のいずれか1つでも欠けると8 barsへ落ちる）を検証した
- [x] 8 bars 以上の Mix Zone が実際に `crossfadestart`→overlap 駆動→promotion まで再生されることを acceptance レベルで確認した（既存9件の beatmix/stem-mix acceptance テストを新しい bar floor に合わせて再較正、全件パス）
- [x] `bun run test:server` で Phase 7-9D の既存挙動が変わっていないことを確認: 736件中 728 pass / 4 fail（`silenceTrim.test.js` の ffmpeg 未インストールによる既知の失敗のみ、Phase 9A-9D のノートに書かれているものと同一）/ 4 skip
- [ ] 16 bars（extended tier）到達の acceptance レベル専用テスト（上記未決事項参照、次フェーズ以降で追加を推奨）
- [ ] 16 bars Mix Zone の実運用での聴感評価（上記未決事項参照）
- [ ] TAIL_WINDOW_SEC(45s) を超える低テンポでの extended tier 到達率の実測（Phase 9F のスコープ、上記未決事項参照）

### 追記: Codex レビュー対応（PR #48, round 1）

初回実装後の Codex レビューで、16-bar (extended) tier のゲーティングと bar 数探索そのものに関わる4件の指摘が見つかった。いずれも「16-bar tier がトラック全体の統計だけで開いてしまい、実際に選ばれる exit/entry ペア自身の品質を見ていない」という同じ根の問題に起因する。

- **P1: 探索がバー数を1刻みで密に走査していた** — `extendedTierEligible()` が真のとき `startBars = 16` から `bars -= 1` の単一降順ループで `minOverlapSec` まで密に走査していたため、§7.2 が定める「16 → 8 → 4」という3段の名前付きティアではなく、その間の任意の整数バー数（15, 14, 13, ...）にも着地しうる実装になっていた。`tierBars = [...new Set([startBars, overlapBars, minOverlapBars])].filter((bars) => bars <= startBars && bars >= minOverlapBars).sort((a, b) => b - a)` を導入し、探索対象を3つの名前付きティアのみに制限した。
- **P1: 16-bar tier がペア自身の phrase 品質を見ずに開いていた** — `extendedTierEligible()` はトラック全体の `downbeatGrid.confidence`/`vocalConfidence` を見るプレフィルタに過ぎず、実際に勝つ exit/entry ペア自身の phrase alignment を見ていなかった。トラック全体では高信頼度でも、たまたま選ばれた候補ペアの phrase 境界自体は弱いことがありうる。`tierBars` ループ内、`bars === MIX_BARS.extended` のときだけ `clamp01(((exit.score ?? 0) + (entry.score ?? 0)) / 2) >= EXTENDED_PHRASE_CONFIDENCE_MIN` を追加で要求し、満たさない場合はそのペアを rejectするのではなく次の（より狭い）ティアにフォールスルーするようにした。
  - テスト: `longMixZoneTracks({ phraseScore: 0.2 })` で、トラック全体の downbeat/vocal confidence は高いが実際に選ばれるペアの phrase score が弱いフィクスチャを用意し、`plan.sync.bars === MIX_BARS.preferred`（8）に落ちることを確認するテストを追加した。
- **P2: `inVocal.fadeSec > 0` の閾値が甘すぎた** — `stemTransition.js` の `planStemTransition()` は inVocal のフェードが技術的に非ゼロでありさえすれば受理していたが、outgoing vocal tail が長い場合、数百ミリ秒未満の「フェードと呼べないほぼ即座のオンセット」でも通過してしまっていた。`MIN_MEANINGFUL_INVOCAL_FADE_SEC = 0.5`（秒）を追加し、`stems.inVocal.fadeSec >= MIN_MEANINGFUL_INVOCAL_FADE_SEC` を要求するよう変更した（満たさない場合は `stem-mix-no-invocal-fade-room` で reject、既存の非stemフォールバックに委ねる）。全バーティア共通の閾値であり、extended tier 専用ではない。
  - テスト: `stemTransition.test.js` に、outgoing vocal tail が長く inVocal のフェード窓がほぼゼロになるフィクスチャ（`lastVocalEndSec: 173.7`、exit=158, preferred/8-bar tier）を追加し、`eligible: false` / `reasons: ['stem-mix-no-invocal-fade-room']` を確認した。
- **P2: 新しい bar floor（4-bar/8秒）に対して既存 acceptance フィクスチャが未較正だった** — 旧 `MIN_OVERLAP_BARS`（2-bar/4秒相当）を前提にした一部の `player.acceptance.test.js` フィクスチャは、新しい 4-bar/8秒の最低ラインを下回る room しか持たず、テスト自身は `mode` を明示的に assert していなかったため、beatmix ではなく静かに phrase-crossfade にフォールスルーしても pass し続けていた——つまり beatmix 固有の経路を実際には検証していなかった。3箇所（"incoming prep for a beatmix plan starts relative to the selected exit point", "TRACK loop mode restarts from the beginning", "re-prepping the same incoming track for a beatmix plan reuses the already-downloaded file"）の `durationSec`/`firstVocalStartSec`/トラック `duration`（および ffmpeg で生成する実音声ファイルの長さ）を、各テストの本来の検証意図・アサーションを変えないまま新しい床を余裕を持って超えるよう広げた。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した（748件中 740 pass / 4 fail / 4 skip）。

### 追記: Codex レビュー対応（PR #48, round 2）

round 1 の修正後、さらに3件の指摘が見つかった。前半2件は tierBars 探索ロジック自体の構造的な欠陥で修正済み、最後の1件はアーキテクチャ上の変更を要するため保留した。

- **P2: `overlapBars` の呼び出し元指定が extended tier で無視されていた** — `extendedTierEligible()` が真のとき `startBars` は常に `MIX_BARS.extended`（16）に上書きされ、呼び出し元が明示的に渡した `overlapBars`（例: `planStemTransition(outgoing, incoming, { overlapBars: 4 })`）が無視されていた。`overlapBars` がデフォルト値（`MIX_BARS.preferred`、8）から明示的に狭められている場合はそれを尊重し、extended tier への昇格を行わないよう修正した（`overlapBars >= MIX_BARS.preferred` を追加条件にした）。デフォルト呼び出し（`overlapBars` 未指定 = 8）では従来どおり extended tier に到達できる。
  - テスト: `planBeatmixTransition(outgoing, incoming, { ...STEM_MIX_OPTIONS, overlapBars: 4 })` で、extended tier の全条件を満たすフィクスチャでも `plan.sync.bars === 4` になることを確認するテストを追加した。
- **P2: バー数探索がペアごとに独立していた（ペア優先 vs ティア優先の逆転）** — 従来の実装は `for (exit) { for (entry) { for (bars) { ...break } } }` という構造で、各 exit/entry ペアごとに「そのペアが収まる最も広いティア」を選び、その後 pairScore を全ペア横断で比較していた。これは「わずかに高スコアだが 4-bar しか収まらないペア」が「スコアはやや低いが 16-bar 全部収まるペア」に勝ってしまう逆転を許していた——`§7.2` が定める `16 → 8 → 4 → fallback` というティア優先の探索順序に反する。ループ構造を `for (bars) { for (exit) { for (entry) {...} } }` に反転し、各ティアで全ペアを評価してから（そのティアで1つでも適合するペアがあれば即座に確定し）次のティアへ降りるようにした。
  - テスト: `beatmixTransition.test.js` に、4-bar タイトルームのみ収まる高スコアのペアと、16-bar 全部収まる低スコアのペアを両方候補として与え、探索が後者（16-bar）を選ぶことを確認するテストを追加した。
- **P2 (保留): 単一ペアの vocal-fade 不足で stem-mix モード全体を reject している** — `planStemTransition()` は `planBeatmixTransition()` が返した単一の勝者ペアに対してのみ `MIN_MEANINGFUL_INVOCAL_FADE_SEC` チェックを行い、不足していればモード全体を reject する。別の候補ペア（例: わずかにスコアは低いが vocal-fade room が十分にある exit）が実際には存在していても、`planBeatmixTransition()` は勝者ペア以外の候補を一切外部に公開しないため、`planStemTransition()` にはリトライする手段がない。根本修正には (a) `planBeatmixTransition()`（または専用の探索関数）が勝ったティア内の候補ペアを複数（上位N件、または全件）公開し、`planStemTransition()` がその中から envelope usable な最初のペアを選ぶよう変更する、または (b) `planStemTransition()` が「除外済みペア集合」を `planBeatmixTransition()` に渡して繰り返し呼び出す（束数を絞ったリトライループ）、のいずれかのアーキテクチャ変更が必要と判断した。(a) は探索を1パスで完結でき無駄がない一方、`planBeatmixTransition()` の戻り値契約を拡張する必要がある。(b) は既存の「単一ペアを返す」契約を変えずに済むが、呼び出しのたびに探索全体をやり直すコストと、無限ループを防ぐための除外集合の管理が必要になる。今回のセッションでは対応を保留し、診断結果と2つの対応方針候補を PR コメントで提示した。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #48, round 3）

round 2 のプッシュ後、さらに2件の実バグが見つかった。いずれも tierBars 探索そのものの構造に関わるもので修正済み。

- **P1: `minOverlapBars` をデフォルトより狭く指定すると標準の4-barティアが消える** — `tierBars` は `[startBars, overlapBars, minOverlapBars]` の3つのパラメータ値だけから構築されていたため、呼び出し元が `minOverlapBars`（例: 既存テストの `minOverlapBars: 2`）をデフォルト（`MIX_BARS.minimum`, 4）より狭く指定すると、`tierBars = [8, 2]` のように標準の4-barティアがそもそも候補から抜け落ちてしまっていた——8-bar(16s)には収まらないが4-bar(8s)には収まる10秒の room を持つペアが、本来の4-barティアを飛ばしていきなりカスタムの2-barフロアまで落ちてしまう。修正: `tierBars` の Set 構築に `MIX_BARS.extended`/`MIX_BARS.preferred`/`MIX_BARS.minimum` の3つの名前付きティアを常に含めるようにした——呼び出し元のカスタム値は「標準ティアに加えて追加のティアを増やす」だけの効果になり、標準ティアを消してしまうことがなくなった。
  - テスト: `minOverlapBars: 2` を渡しつつ、8-barには収まらないが4-barには収まる room（9秒）を持つ既存の "degrades... down to 4" と同じフィクスチャで、`plan.sync.bars === 4`（2ではなく）になることを確認するテストを追加した。
- **P1: marginal-tempo の信頼度ゲートがペア単位ではなく探索後の勝者1件にのみ適用されていた** — round 2 の「ティア優先・ペアは内側」の探索構造では、あるティアで最初に見つかった適合ペアで即座に `break` してしまうため、`isMarginalTempo && best.pairScore < MARGINAL_TEMPO_MIN_SCORE` のチェックはループの外で最終的な `best`（＝そのティアの勝者）に対してしか行われていなかった。広いティアには room はあるが品質の低い（marginal-tempo の閾値未満の）ペアしかなく、狭いティアには品質の高い（閾値を超える）別のペアがある場合、探索は広いティアの低品質ペアで先に確定してしまい、遷移全体が `marginal-tempo-low-confidence` で reject されていた——実際には狭いティアの高品質ペアが利用可能だったにもかかわらず。修正: extended tier の phraseAlignment ゲートと同じパターンで、marginal-tempo のスコアチェックをペアごとの評価内に移動した。閾値を満たさないペアはそのティアでスキップされ（次の候補ペアまたは次のティアへフォールスルー）、ループ終了後の最終判定は「そもそも1件もペアが見つからなかった（`no-overlap-fit`）」場合と「room的には適合するペアがあったが marginal-tempo の品質チェックで全て弾かれた（`marginal-tempo-low-confidence`）」場合を区別する `anyMarginalRejected` フラグで賄うようにした。
  - テスト: room は潤沢だが低品質（score ~0.682、閾値0.7未満）のペアと、room は4-barティア分しかないが高品質（score ~0.784）のペアの両方を候補として与え、後者が正しく見つかること（`plan.sync.bars === MIX_BARS.minimum`、`plan.outgoing.exitStartSec === 290`）を確認するテストを追加した。数値は `scoreTransitionPairDetailed()` を直接呼ぶデバッグスクリプトで実測して較正した。

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

### 追記: Codex レビュー対応（PR #48, round 4）

round 3 のプッシュ後、さらに1件の実バグが見つかった。

- **P2: `overlapBars: 16` を直接渡すと extended tier のゲートが素通りしていた** — round 2 の修正（`overlapBars` が `MIX_BARS.preferred` 未満に狭められている場合は `extendedTierEligible()` による upgrade を行わない）は「デフォルトより狭い場合の upgrade」だけを扱っており、呼び出し元が直接 `overlapBars: 16` を渡した場合は `extendedTierEligible()` の結果に関わらず `startBars` がそのまま 16 になっていた。`tierBars` は常に `MIX_BARS.extended` を候補として含む（round 3 の修正）ため、この経路では 16-bar ティアがペア単位の phraseAlignment チェックだけしか通らず、stem 利用可否・両側の vocalConfidence という §7.2 の残り2条件を完全にスキップしてしまっていた——plain（非 stem）呼び出しで vocalConfidence が低くても 16-bar プランが成立しうる状態だった。修正: `extendedTierEligible()` の結果を1回だけ計算して `extendedEligible` に保持し、`bars === MIX_BARS.extended` のペア単位ゲートで phraseAlignment チェックに加えて `extendedEligible` 自体も要求するようにした——探索がどの経路で 16-bar ティアに到達したか（デフォルトからの upgrade か、呼び出し元による直接指定か）に関わらず、§7.2 のトラック全体条件が必ず成立している必要がある。
  - テスト: `overlapBars: MIX_BARS.extended` を直接渡しつつ、両側の `vocalConfidence` を `EXTENDED_VOCAL_CONFIDENCE_MIN` 未満に設定したフィクスチャで、`plan.sync.bars === MIX_BARS.preferred`（16ではなく）になることを確認するテストを追加した。修正を revert すると期待どおり 16 が返ることを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #46, round 5）

round 4 のプッシュ後、さらに2件の実バグが見つかった。

- **P2: marginal-tempo の信頼度ゲートが常に strict スコアを見ていた** — round 2 の根本修正（`planBeatmixTransition()` の探索を `stemAware` の値に関わらず常に strict スコアでランキングする）以降、`isMarginalTempo && best.pairScore < MARGINAL_TEMPO_MIN_SCORE` の判定も同じ strict `pairScore` を再利用していた。しかし stem-mix 候補にとって、mid-vocal な exit の strict vocalSafety はゼロになりうる——それこそが stem separation が安全にする対象そのものであり、relaxed（`stemAware: true`）スコアなら閾値をクリアする場合がある。修正: marginal-tempo の適格性判定だけ、`stemAware` が true のときは同じペアを `stemAware: true` で再スコアリングした値を使うようにした（どのペアが勝つか自体は引き続き strict スコアで決まる）。
  - テスト: 深く mid-vocal な exit（strict score ~0.53、閾値0.7未満）だが relaxed score は ~0.768（閾値クリア）というフィクスチャで、`stemAware: true` 呼び出しが `eligible: true` になることを確認するテストを追加した。数値は `scoreTransitionPairDetailed()` を直接呼ぶデバッグスクリプトで実測して較正した。
- **P2: TRACK loop のエントリーリセットが phrase-crossfade の baseSwap/EQ を剥がしていなかった** — TRACK loop（`next === current`）がエントリーを強制的に 0 へリセットする際、`norm.mixPlan.mode === 'beatmix'` のときだけ `baseSwap`/`sync`/`eq` を剥がしていた。Phase 9D の独立ランカー以降、beatmix が原理的に ineligible（例: BPM データなし）でも phrase-crossfade 単独で勝つケースがあり、そのケースでは元々選択されたフレーズ境界向けの `baseSwap: true`/EQ がそのまま、実際にはエントリー0（曲の先頭）から再生される音声に適用されてしまっていた。修正: `normalizeTransitionPlan()` を呼ぶたびに、どの raw plan（`selectedPlan` か、stem-mix 降格時の `bestNonStemPlan`）が現在 `norm` に反映されているかを `normRawMode` として追跡し、`norm.mixPlan.mode === 'beatmix' || normRawMode === 'phrase-crossfade'` のときに剥がすよう拡張した。
  - テスト: BPM データなし（beatmix が bpm-unavailable で ineligible、phrase-crossfade のみが候補）のフィクスチャで TRACK loop を有効にし、`planBeatSyncedTransition()` の raw plan が実際に `phrase-crossfade`（`baseSwap: true`、エントリーは非ゼロ）であることをテスト不変条件として確認した上で、実際の TRACK loop 再生後に `startedPlan.baseSwap === false` になることを確認するテストを追加した。修正を revert すると `baseSwap` が `true` のまま漏れることを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #46, round 6）

round 5 のプッシュ後、さらに2件の指摘が見つかった。いずれも「ある時点で正しく計算された値が、その後の別の分岐で更新されずに古いまま使われ続ける」という同じ種類の見落としで、片方は round 2/3 の探索アーキテクチャの教訓（post-hoc 補正では既に捨てたペアを復元できない）が marginal-tempo ゲートには波及していなかったケース、もう片方は round 5 の `.entry` reconciliation と対になるはずの `.exit` 側が漏れていたケース。

- **P2: marginal-tempo ゲートが strict 勝者ペアの post-hoc 再チェックのままだった** — `planBeatmixTransition()` の探索ループ自体は round 2 の根本修正で常に strict スコアでランキングしているが、marginal-tempo 判定（`isMarginalTempo && ... < MARGINAL_TEMPO_MIN_SCORE`）はループの外、strict スコアで既に選ばれた単一の `best` ペアに対してのみ実行されていた。これは round 2/3 で stem-mix/phrase-crossfade の探索そのものに適用したのと全く同じ「post-hoc 補正は、探索が既に他のペアを捨ててしまったあとでは救えない」構造上の欠陥で、marginal-tempo ゲートには波及していなかった。具体的には、strict スコアで僅差で勝つ vocal-safe なペアがマージナル閾値を割り込む一方、strict スコアでは僅差で負けるが marginal 判定用の（`stemAware` なら relaxed）スコアなら閾値を大きく超える別のペアが存在する場合、探索ループが前者を選んだ時点で後者は既に捨てられており、post-hoc チェックは前者を reject するだけで後者へのフォールバックができず、`marginal-tempo-low-confidence` で丸ごと不合格になっていた。
  - 修正: `beatmixTransition.js` の探索ループ内で、`isMarginalTempo` のときは各ペアごとにマージナル判定用スコア（`stemAware` なら `stemAware: true` で再計算、そうでなければ strict の `pairScore` をそのまま使用）を都度計算し、閾値を下回るペアはその場で候補から除外（`anyMarginalRejected` フラグを立てて次のペアへ）してから `best` の更新判定に進むよう変更した。全ペアが reject された場合のみ最終的に `marginal-tempo-low-confidence` で不合格にする。9D（`beatmixTransition.js` の単純な密探索）と 9E（tiers-outer 構造の探索）の両方のアーキテクチャに、それぞれの構造に合わせた形で同じ修正を適用した。
  - テスト: strict スコアの勝負では vocal-safe な exit（marginal 判定でも threshold 未満）が勝つが、marginal 判定のスコアでは threshold を上回る mid-vocal な exit が別に存在する、という `stemAware: true` 呼び出し用フィクスチャを `beatmixTransition.test.js` に追加し、`planBeatmixTransition()` が後者（`exitStartSec` が mid-vocal 側の値）を選んで `eligible: true` になることを確認した。数値は `scoreTransitionPairDetailed()` を直接呼ぶデバッグスクリプトで実測して較正した。
- **P2: TRACK loop の stem-mix→bestNonStemPlan 降格が `transitionPlanReport.exit` を更新していなかった** — TRACK loop が stem-mix から `bestNonStemPlan` へ再プランする際（round 5 で追加した `norm = normalizeTransitionPlan(bestNonStemPlan)` の降格パス）、`transitionPlanReport.exit` はレポート構築時点（降格より前）のオリジナル `selectedPlan`（stem-mix）の exit のまま更新されていなかった。`bestNonStemPlan` は relaxed ではない独立した探索から得られるため、stem-mix とは全く異なる exit ペアを選ぶことが構造的にあり得る（stem-mix の relaxed 探索は mid-vocal な exit も候補にできるが、strict な非 stem 系探索はそもそも vocal-safe な exit しか候補に入れない）。round 5 で追加した entry 側の reconciliation（`pendingEntrySec`）は entry のみを直しており、exit 側の同じ問題には未対応だった。結果、実際に再生される音声は `bestNonStemPlan` の exit で降格しているのに、コミットされる `[MIX PLAN]` ログの `.exit` はオリジナルの stem-mix の exit（秒数・bar・vocalActive）を報告し続けてしまっていた。
  - 修正: `transitionLog.js` の（元々 private だった）`exitInfo()` を export し、`player.js` の降格分岐内で `transitionPlanReport.exit = exitInfo(bestNonStemPlan, outAnalysis, this.#sessionTempo.tempoRatio ?? 1)` を呼んで再計算するようにした。
  - テスト: 同一トラックの分析を outgoing/incoming 両方に使う TRACK loop フィクスチャで、tail に mid-vocal（stem-mix の relaxed 探索でのみ勝てる、phrase score が高い exit）と vocal-safe（strict 探索が唯一見られる exit）の2候補を用意し、`selectedPlan`（stem-mix）は前者の exit を、`bestNonStemPlan`（beatmix）は後者の exit を選ぶフィクスチャで、コミットされた `[MIX PLAN]` レポートの `report.exit.sec` が `bestNonStemPlan` 側の exit になることを確認するテストを `player.acceptance.test.js` に追加した。修正を revert すると、期待どおり `report.exit.sec` がオリジナルの stem-mix の exit のまま漏れることを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #45, round 4）

- **P2: 明示的な `pause()` 単発呼び出しに対して maxStoppedMs のタイムアウトが実際には効いていなかった** — `applyPause()` の `maxStoppedMs` チェックは、自分自身が**再度呼ばれたとき**にしか走らない。`noteUnderrun()` 経由の debounce パスは、実際のアンダーランが続く限りミキサーが繰り返し `noteUnderrun()` を発火させるため、この再チェックが自然に機能する。しかし §5.4 の明示的な `pause(source)` コマンドは edge-triggered（1回呼ばれて、通常は1回の `resume()` と対になるだけ）であり、その `resume()` が来ない場合（呼び出し元の CPU 監視やプレイヤーが消えた、あるいは対応する `noteUnderrunCleared()` が呼ばれ損ねたなど）、SIGSTOP されたままの Demucs 子プロセスを誰も気に留めず、stem キュー全体が永久にブロックされ得た。`applyPause()` が新規に一時停止へ遷移するたび（`noteUnderrun()`/`pauseQueue()`/`pump()` の3経路すべて）に実際の `setTimeout` を張る `armStopTimeout()`/`clearStopTimeout()` を追加し、`applyPause()` の再呼び出しの有無に関わらず `maxStoppedMs` 経過時に確実に `killCurrent()` されるようにした。resume 系（`noteUnderrunCleared()`、`killCurrent()` 自身、`pump()` の完了パス）ではタイマーを解除する。
  - テスト: `queue.pause()` を**一度だけ**呼び、その後一切追加の呼び出しをせずに `maxStoppedMs` 経過後、ジョブが自動的に kill されることを確認するテストを追加した（既存の「2回目の `pause()` 呼び出しで初めてタイムアウトに気づく」テストとは区別される）。実際の `setTimeout` を使うため、注入可能な `clock` オプションでは検証できない（`clock` は経過時間の**比較に使う値**を差し替えるだけで、その比較が**いつ再実行されるか**は差し替えない）。タイマーに `unref()` を付けると、他に何もイベントループを保持するものがない単体テスト環境ではタイマー発火前にプロセスが終了してしまい正しく検証できないことが判明したため、`unref()` は使用していない（本番のボットプロセスは他のハンドル・タイマーで常にイベントループが保持されているため、この差は本番動作には影響しない）。

### 追記: Codex レビュー対応（PR #48, round 5）

PR #46 の round 6 マージ後、9E 側の実装にも2件の指摘が見つかった。片方は round 2 の修正がカバーしていなかった境界ケース、もう片方は round 1 で導入した post-hoc チェックが、このセッションで繰り返し見つかっている「探索中に捨てられたペアは post-hoc 補正では復元できない」というバグの類型そのものだった。

- **P2: `overlapBars` の明示的な ceiling が preferred 幅より上（8〜15）の場合に尊重されていなかった** — round 2 の修正（`overlapBars` が `MIX_BARS.preferred` **未満**に狭められている場合のみ extended tier への upgrade を止める）は `overlapBars >= MIX_BARS.preferred && extendedEligible` という条件で実装されていたため、`overlapBars: 12` のような「preferred(8) 以上だが extended(16) 未満」の明示的な ceiling も upgrade 対象に含まれてしまい、呼び出し元が要求した 12-bar の上限を無視して 16-bar まで広げてしまっていた。修正: upgrade 対象を「呼び出し元が `overlapBars` を一切指定しなかった場合（デフォルト値 `MIX_BARS.preferred` のまま）」に厳密化し、`overlapBars === MIX_BARS.preferred` で判定するようにした——デフォルトより狭い値もデフォルトより広い（だが16未満の）値も、等しく「明示的な ceiling」として尊重する。
  - テスト: `longMixZoneTracks()`（extended tier が本来なら成立するフィクスチャ）に `overlapBars: 12` を明示的に渡し、`plan.sync.bars === 12`（16 ではなく）になることを確認するテストを追加した。修正を revert すると期待どおり 16 が返ることを確認済み。
- **P2: stem-mix の inVocal フェード幅チェックが、探索中に捨てられた他のペアを試さずにプラン全体を reject していた** — round 1 で追加した `MIN_MEANINGFUL_INVOCAL_FADE_SEC` チェックは、`planBeatmixTransition()`（内部で `stemAware: true` として呼ばれる）が strict スコアで選び終えた単一の勝者ペアに対してのみ、事後的に `stemTransition.js` 側で実行されていた。しかし、strict スコアで僅差で勝つ mid-vocal な exit（outgoing vocal tail が長く、inVocal のフェード幅がほぼ 0 になる）がある一方で、strict スコアでは負けるが outgoing vocal tail が短く十分なフェード幅を残す別の exit が存在する場合、探索はすでに前者を勝者として確定させてしまっており、事後チェックはプラン全体を reject するだけで後者を再検討できなかった——marginal-tempo ゲート（PR #46 round 6）やstem-mix/phrase-crossfade のランキング（PR #46 round 2-3）で繰り返し修正してきたのと全く同じ「post-hoc 補正は探索が既に捨てたペアを復元できない」という構造上の欠陥。
  - 修正: `planBeatmixTransition()` に汎用的な `pairFilter` オプション（呼び出し元が各候補ペアを独自の理由で reject できるコールバック）を追加した——`beatmixTransition.js` 自身は vocal envelope の意味論を一切知る必要がなく、marginal-tempo ゲートと同じ形（`anyMarginalRejected` に相当する `anyPairFilterRejected`）で per-pair に組み込むだけで済む。`stemTransition.js` の `planStemTransition()` は、探索ループの中で毎ペアに対して「このペアが選ばれた場合の inVocal フェード幅」を計算する `pairFilter` を渡すよう変更した——`buildStemEnvelopes()` と全く同じ計算式を共有する `estimateInVocalFadeSec()` を新規に切り出し、探索中の事前チェックと最終的な envelope 構築が絶対に食い違わないようにしている。全ペアが `pairFilter` で reject された場合のみ、`planBeatmixTransition()` は汎用的な `'pair-filter-rejected'` 理由で reject し、`planStemTransition()` がそれを外部向けの具体的な理由文字列 `'stem-mix-no-invocal-fade-room'`（既存のテスト・呼び出し元がそのまま参照できる）にマッピングし直す。
  - テスト: round 1 のフィクスチャ（sec 158、tail 15.7s、フェード幅ほぼ0）に、strict スコアでは負けるが tail が 1.7s と短い sec 172（フェード幅 14.1s、十分に使える）を追加候補として与え、`planStemTransition()` が sec 172 側を選んで `eligible: true` になること、`stems.inVocal.fadeSec` が閾値をクリアすることを確認するテストを追加した。修正を revert すると、期待どおりプラン全体が reject されることを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #48, round 6）

round 5 のプッシュ後、さらに2件の指摘が見つかった。片方は §7 の tier 制導入が Phase 9D 以前から存在する `src/mix/ordering.js` の近似スコアリングと食い違ってしまっていたケース、もう片方は round 5 自身の `overlapBars` ceiling 修正に残っていた境界値の見落とし。

- **P2: `src/mix/ordering.js`（MIX プレイリスト並び替え用の近似コスト関数）が、実際のライブプランニングが選ばないペアのスコアを使っていた** — `transitionCost()` の beatmix 項（`beatmixCompatibilityCost()`)は、`MIN_OVERLAP_BARS`（4-bar）の room floor さえクリアしていれば全 exit×entry ペアの中から**最高スコア**を採用していた。これは Phase 9E 以前（`planBeatmixTransition()` 自身が「各ペアが収まる最も広い tier を個別に取り、その中で raw score を比較する」という pairs-outer 構造だった頃）は正しい近似だったが、9E round 2 の tiers-outer/pairs-inner 再構成（「どのペアであれ、最も広い tier に何か1つでも収まればそのtierが無条件で勝つ」）後は、ライブプランニングが実際には選ばない——8-bar tier にしか収まらない「まずまず」のペアより、4-bar tier にしか収まらない「非常に良い」ペアの方をスコアに使ってしまう——ケースが生じていた。結果、MIX プレイリストの並び替えが、実際の再生では絶対に得られない品質を前提に最適化されてしまう。
  - 修正: `beatmixCompatibilityCost()` の探索を `planBeatmixTransition()` と同じ tiers-outer/pairs-inner 構造に変更した。`[MIX_BARS.preferred, MIX_BARS.minimum]` の順に tier を試し、各 tier ごとに（その tier 幅で計算し直した `minOverlapSec` で）exit candidate を再計算し（exit 側の room 要件は `findExitCandidates()` 自身が担っているため、tier ごとに再フィルタが必要）、entry 側の room チェック（`forwardSafePlayback`/`roomInIncomingPlayback`）もその tier の `minOverlapSec` で行う。tier 内で最高スコアのペアが1つでも見つかれば即座にそのスコアを採用し、より狭い tier は一切見ない——ちょうど `planBeatmixTransition()` の `bestAtTier`/`break` と同じ意味論。extended（16-bar）tier は `ordering.js` が stem-aware 評価を行わない（プレイリスト並び替え段階ではまだステム分離確認をしない）ため対象外のまま。
  - テスト: 20s の room を持つ exit（score 0.5、8-bar/16s tier を余裕でクリア）と、10s の room しかない exit（score 0.99、4-bar/8s tier しかクリアしない）を両方候補として与え、`transitionCost()` の結果が「20s の exit だけを候補にした場合」と完全に一致する（＝10s の exit の高スコアが混入しない）ことを確認するテストを追加した。10s の exit だけを候補にした場合のコストと比較して確実に悪い（コストが高い）ことも確認し、フィクスチャ自体が実際に両者を区別できていることを検証した。修正を revert すると、期待どおり 10s の exit の高スコアが使われてコストが下がってしまうことを確認済み。
- **P2: 明示的な `overlapBars: MIX_BARS.preferred`（8）ちょうどの ceiling が、無指定のデフォルトと区別できていなかった** — round 5 の修正は `overlapBars === MIX_BARS.preferred` を「caller が何も渡さなかった」ことの判定に使っていたが、関数シグネチャの destructure 自体が `overlapBars = BEATMIX_OVERLAP_BARS`（`= MIX_BARS.preferred`）というデフォルト値を持っていたため、caller が明示的に `overlapBars: MIX_BARS.preferred` を渡した場合と、何も渡さなかった場合とで、この時点で既に区別不可能な同じ値になってしまっていた。結果、明示的な8-bar ceiling も無条件で 16-bar へ upgrade されてしまう——round 5 が「12 のような境界外の値」について解決したのと全く同じ種類の問題が、たまたまデフォルト値と数値が一致する境界ケースにだけ残っていた。
  - 修正: `overlapBars` の destructure からデフォルト値を外し（`overlapBars,` のみ、初期値なし）、`overlapBars !== undefined` を「caller が明示的に渡したか」の判定に使う `overlapBarsExplicit` を新設した。以降の計算はすべて `effectiveOverlapBars`（`overlapBarsExplicit` なら `overlapBars` そのまま、そうでなければ `BEATMIX_OVERLAP_BARS`）を参照するよう統一し、extended tier への upgrade 判定は `!overlapBarsExplicit && extendedEligible`（「本当に何も渡されなかった」場合のみ）に変更した。
  - テスト: `overlapBars: MIX_BARS.preferred` を明示的に渡した extended-tier-eligible なフィクスチャで `plan.sync.bars === MIX_BARS.preferred`（16 ではなく）になることを確認するテストを追加した。既存の「デフォルト（overlapBars 無指定）なら 16-bar tier に到達する」テストが今も通ることも確認し、無指定ケースの upgrade 挙動を壊していないことを検証した。修正を revert すると、期待どおり明示的な8-bar ceiling が 16 に upgrade されてしまうことを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #48, round 7）

round 6 のプッシュ後、さらに2件の指摘が見つかった。いずれも round 6 自身の修正に残っていた境界ケースの見落とし。

- **P2: `bars === MIX_BARS.extended` の厳密等価チェックが、16 を超える caller 指定の overlapBars を素通りさせていた** — round 4 の修正（extended tier の全ゲートを `bars === MIX_BARS.extended`（16 ちょうど）のときだけ強制する）は「caller が `overlapBars: 17` のように 16 を超える値を明示的に渡す」ケースを想定していなかった。`tierBars` はこの場合 `[17, 16, 8, 4]`（幅の広い順）となり、探索はまず `bars: 17` を試すが、`17 !== 16` なのでゲートブロック全体がスキップされ、stem 利用可否・vocalConfidence・phraseAlignment のどれも確認せずに 16-bar より長い遷移を許してしまっていた。
  - 修正: `bars === MIX_BARS.extended` を `bars >= MIX_BARS.extended` に変更した——extended tier ちょうどだけでなく、それを超える幅すべてに同じゲートを適用する。
  - テスト: `longMixZoneTracks({ outgoingVocalConfidence: 0.5, incomingVocalConfidence: 0.5 })`（vocalConfidence 不足で extended tier 不適格なフィクスチャ）に `overlapBars: 17` を明示的に渡し、`plan.sync.bars === MIX_BARS.preferred`（17 のまま通らない）になることを確認するテストを追加した。round 4 の既存テスト（`overlapBars: 16` ちょうど）が今も通ることも確認した。修正を revert すると、期待どおり 17-bar プランがそのまま通ってしまうことを確認済み。
- **P2: `src/mix/ordering.js` の marginal-tempo ゲートが、tier を確定させたあとに一度だけ適用されていた** — round 6 で `beatmixCompatibilityCost()` を tiers-outer/pairs-inner 構造に書き換えた際、marginal-tempo の信頼度チェック（`MARGINAL_TEMPO_MIN_SCORE`）はループ**の外**、最終的な `bestScore` に対してのみ残っていた。しかしこれは PR #46 round 6 で `planBeatmixTransition()` 自身に対して修正したのと全く同じ問題——tier ループが「そのtierで最初に見つかった適合ペア」を無条件で採用して `break` してしまうため、閾値未満のペアが広い tier で先に見つかった場合、より狭い tier に閾値をクリアする良いペアが存在していても、ループはそこへ到達する前に確定してしまう。結果、ライブプランニングなら実際に成立する遷移が、`ordering.js` の近似では完全な infeasibility として扱われてしまっていた。
  - 修正: marginal-tempo のスコアチェックを tier ループの**内側**、各ペアのスコア計算直後に移動した（`match.tier === 'marginal' && score < MARGINAL_TEMPO_MIN_SCORE` なら `continue`）。`planBeatmixTransition()` 自身の `anyMarginalRejected` と全く同じ意味論——閾値未満のペアはそのtier内の他のペア、そして必要ならより狭いtierへと、探索を止めずにスキップされる。ループ後の後付けチェックは（閾値未満のペアがそもそも `bestAtTier`/`bestScore` に反映されなくなったため）冗長になったので削除した——`bestScore` が 0 のまま残るケース（marginal 理由であれ room 不足であれ）は既存の `return 1 - bestScore`（`1 - 0 = 1 = BEATMIX_INFEASIBLE_COST`）がそのまま同じ値を返す。
  - テスト: 20s の room を持つ exit（marginal tempo 込みでスコアが 0.7 未満、8-bar tier を余裕でクリア）と、10s の room しかない exit（スコア 0.7 超、4-bar tier しかクリアしない）を両方候補として与え、`transitionCost()` の結果が「10s の exit だけを候補にした場合」と完全に一致する（＝20s の exit の閾値未満スコアが tier をブロックしない）ことを確認するテストを追加した。数値は `scoreTransitionPair()` を直接呼ぶデバッグスクリプトで実測して較正した（entry 側の phrase score を通常の 0.9 から 0.2 に下げないと、20s の exit のスコアが偶然 0.7 をわずかに上回ってしまい閾値の差が生まれなかったため）。修正を revert すると、期待どおり 20s の exit のスコアがそのまま使われてコストが悪化することを確認済み。
- テスト: `bun run test:server` を再実行し、`silenceTrim.test.js` の既知の4件（ffmpeg 未インストール）以外に regression が無いことを確認した。

## 実装ノート (Phase 9F)

§8 の Exit Candidate 探索範囲拡張を実装した。tail 解析窓を 45 秒から §8.2 の指定レンジ（60-90秒）の下限である 60 秒へ広げ、findExitCandidates() が実際に探索する候補プールをその新しい窓幅まで届かせた。

### 実装箇所

- `src/audio/vocalActivity.js`: `TAIL_WINDOW_SEC` を 45→60 に変更した。60 秒（レンジの下限）を選んだ理由: 64 BPM/4-beat での 16 bars がちょうど 60 秒（`60 / 64 * 4 * 16 = 60`）になるため、Phase 9E で導入した extended tier（16 bars）が現実的なミキシングテンポ域の下限付近までフルに届くようになる一方、Demucs のtail解析コストの増分は 90 秒（約100%増）よりずっと小さい約33%増（45→60秒）に抑えられる。`analyzeVocalActivity()` 自体は既に `tailWindowSec` を引数として受け取っていたため、コード変更はこの定数1箇所のみ。
- `src/audio/trackAnalysis.js`: **本 phase で見つかった潜在バグの修正が実装の核心**。`findExitCandidates()`（`beatmixTransition.js`）が実際に検索する候補プール（`phrases.tail`/`downbeatGrid.tail`）は `vocalActivity.js` の `TAIL_WINDOW_SEC` ではなく、`trackAnalysis.js` に**別々に**ハードコードされていた `TAIL_BPM_WINDOW_SEC`（同じく 45）というもう1つの定数でサイズが決まっていた。両者は同じ「tail 解析窓」という概念を指しているにもかかわらず、コード上は完全に独立した2つの定数として存在しており、`TAIL_WINDOW_SEC` だけを広げても `analyzeTrackFile()` が構築する beatGrid.tail/phrases.tail の実際の到達距離（＝ findExitCandidates() が探索できる範囲）は 45 秒のまま変わらない——Demucs のボーカル解析窓（`vocal.lastVocalEndSec`/`vocalGaps` の計算範囲）だけが広がり、完了条件が要求する「phrase boundary 自体を45秒より前から選択可能にする」という実際の効果は一切得られない、という状態になっていた。`TAIL_BPM_WINDOW_SEC` を独立した値ではなく `TAIL_WINDOW_SEC`（`vocalActivity.js` からインポート）からの派生値に変更し、この2つの窓が今後も再び乖離しないようにした。
- `src/player.js`: `MAX_TRANSITION_LEAD_SEC`（`= TAIL_WINDOW_SEC`）周りの既存コメント（60秒への変更を反映、旧45秒ベースの具体例を更新）と、prep ゲートの早期リターン閾値まわりのコメントを更新した。ロジック自体の変更はなし（`MAX_TRANSITION_LEAD_SEC` は既に `TAIL_WINDOW_SEC` のエイリアスだったため、定数の値が変わるだけでゲートの閾値は自動的に 75 秒（`CROSSFADE_PREP_LEAD_SEC(15) + TAIL_WINDOW_SEC(60)`）に追従する)。
- テスト:
  - `src/audio/vocalActivity.test.js`: 「overlap-branch envelope slicing」テスト（60秒トラック、head/tail 窓の重なり境界を検証するテスト）が `tailWindowSec` のデフォルト値に暗黙に依存していたため、`tailWindowSec: 45` を明示的に渡すよう修正し、このテストの意図したシナリオ（`tailStart = max(0, 60-45) = 15` での head/tail overlap）をデフォルト値の変更から切り離した。
  - `src/audio/trackAnalysis.test.js`: 新規テスト「analyzeTrackFile widens beatGrid.tail/phrases.tail reach in lockstep with TAIL_WINDOW_SEC」を追加。70秒のフェイクトラックで `analyzeTrackFile()` を呼び、`beatGrid.tail.startSec` が新しい `TAIL_BPM_WINDOW_SEC`（60秒）ぶん後退していること（`70-60=10`）、かつ旧45秒境界（`70-45=25`)より前に到達していることを確認する。`TAIL_BPM_WINDOW_SEC = TAIL_WINDOW_SEC` の派生を外して 45 に固定し戻すと、このテストは `startSec=25`（期待は10未満）で期待どおり失敗することを確認済み（revert-test-restore で検証)。ffmpeg/aubiotrack のフル実行は不要——`bash -lc 'command -v aubiotrack'` の応答を「見つからない」にすることで BPM/beat パイプラインを `available:false` で早期終了させ、`tailStart` の計算（これが検証対象そのもの）だけを純粋に検証している。
  - `src/player.acceptance.test.js`: 「crossfade timer defers analysis until the transition window」テストのコメントを、新しい75秒境界（旧60秒）を反映するよう更新した（アサーション自体は90秒のトラック長がどちらの境界でも変わらず閾値を超えるため無変更)。
  - `bun run test:server` を再実行し、regression が無いことを確認した: 768件中 760 pass / 4 fail（`silenceTrim.test.js` の ffmpeg 未インストールによる既知の失敗のみ、Phase 9A-9E のノートに記載されているものと同一）/ 4 skip。`player.acceptance.test.js` 単体実行では稀に2件（"chained beatmix transition" と "stem-mix pair marked unavailable" のタイムアウト系）が本 phase の変更と無関係に落ちることがあるが、この worktree で Phase 9F の変更を `git stash` して確認したところベースライン（Phase 9E マージ済みの状態）でも同じ2件が同じ理由（5000msタイムアウト、サンドボックス環境のリソース状況に依存する既知のフレーク）で落ちることを確認済み。

### 未決事項 / 既知の制約

- **§8.2 が明示する 60-90 秒レンジのうち、今回は下限の60秒のみを採用した**: §8.2 自身が「将来的には固定秒数ではなくphrase境界リストベースの探索にすべき」としており、固定秒数のレンジ内でどこを選ぶかは本質的にコストとカバレッジのトレードオフでしかない。60秒は「BPM 64 以上なら16-bar extended tierがフルに届く」水準であり、これを下回るテンポ（バラードなど、より遅いテンポの楽曲）では引き続き extended tier の到達距離が窓の外にはみ出しうる。より広い窓（例えば90秒）へ拡張する、あるいは§8.2が示唆する phrase-boundary-list ベースの探索へ移行するかは、Phase 9A-9E のノートが繰り返し指摘している「実運用でどれだけの割合の遷移が extended tier に到達するか」の実測結果を踏まえて次フェーズ以降で判断すべき事項として保留した。
- **Demucs tail解析コストの実測は未実施**: 45→60秒への変更が実際の解析時間・CPU負荷にどの程度影響するかは、本エージェント環境では実測できていない（tail窓の長さ増分から比例的に見積もった約33%増という数字は概算）。
- **実測評価は未実施**: Phase 9A-9E のノートが繰り返し書いている制約と同じく、拡張された tail 窓が実際の楽曲・実運用でどれだけの割合の遷移を「以前は届かなかった exit candidate」まで到達させるかは、実音源・実 Discord セッションでの確認が必要で、本エージェント環境では実施できない。

### 完了条件（§8/§17 9F 相当）

- [x] `TAIL_WINDOW_SEC`（`vocalActivity.js`）を 45→60 秒に拡張した（§8.2 の 60-90 秒レンジの下限)
- [x] `findExitCandidates()` が実際に検索する候補プール（`phrases.tail`/`downbeatGrid.tail`、`TAIL_BPM_WINDOW_SEC` でサイズが決まる）も同じ幅まで拡張し、2つの独立した「tail窓」定数が乖離していた潜在バグを修正した——これが無いと定数を広げても完了条件の実効果が得られないことをテストで確認済み
- [x] 「曲末45秒より前のphrase boundaryをexitとして選択可能」（§17 9F の完了条件）を、`analyzeTrackFile()` の `beatGrid.tail.startSec` が新しい60秒窓ぶん後退することを検証するテストで構造的に確認した
- [x] `bun run test:server` で Phase 7-9E の既存挙動が変わっていないことを確認した（768件中 760 pass / 4 fail はいずれも ffmpeg 未インストールによる既知の失敗のみ / 4 skip）
- [ ] 60-90秒レンジ内でのより広い値（例: 90秒）への拡張、または phrase-boundary-list ベースの探索への移行（上記未決事項参照、次フェーズ以降）
- [ ] 拡張された tail 窓の実運用での効果測定（extended tier 到達率の変化、Demucs解析コストの実測）（上記未決事項参照）

### 追記: Codex レビュー対応（PR #52, round 1）

初回実装後の Codex レビューで2件の指摘が見つかった。いずれも tail 窓拡張そのものではなく、拡張の副作用として新たに顕在化した既存の潜在バグ。

- **P1: 解析キャッシュのバージョンを上げていなかった** — `src/web/server/routes/internal.js` と `player.js` の `#getCachedAnalysis()` はどちらも `(row.version ?? 1) < ANALYSIS_VERSION` で解析結果の再利用可否を判定している。`ANALYSIS_VERSION`（`trackAnalysis.js`）を据え置いたまま tail 窓だけ広げると、アップグレード前に version 3 で解析済みの既存トラックは version チェックを素通りしてキャッシュがそのまま使われ続け、45秒窓のままの beat/phrase/vocal データを無期限に返し続ける——新しい60秒解析は「これから初めて解析される」トラックにしか効かず、既存トラックには何の効果もないまま出荷されてしまう。
  - 修正: `ANALYSIS_VERSION` を 3→4 に上げた。既存の 1→2、2→3 の前例と同じ扱い（解析結果のペイロード内容が実質的に変わる変更は毎回この定数を上げる、というこのコードベースの既存の規約）。
  - テスト: `src/web/server/routes/internal.test.js` の `POST /internal/optimize-order probes the tempo backend once and threads it through to ordering` が、アンカートラックの解析行を `version: 3` に決め打ちして DB に挿入していたため、`ANALYSIS_VERSION` が4になった時点でこの行が「古すぎる」と判定されて無視されるようになり、テストの意図（beatmix 項が実際に効いていることの確認）が壊れて失敗するようになった——これは新しい回帰ではなく、このテスト自身が既に自分自身のコメントで警告していた失敗モード（アンカーが解決できないとテストが「間違った理由で」パスしてしまう）がバージョンチェックの片側で表面化したもの。ハードコードされた `3` を `ANALYSIS_VERSION`（既にこのテストファイルの他の箇所でインポート済み）からの参照に変更し、以後この定数が変わってもこのテストが自動的に追従するようにした。
- **P2: プロモート済みトラックの exit 候補プールが自分自身の entry offset を考慮していなかった** — A→B の beatmix/phrase/stem-mix 昇格で B が nonzero な `#currentEntrySec`（ネイティブ・シーク位置）を持って `#current` になったあと、B 自身の B→C exit 候補プール（`findExitCandidates()` が検索する `phrases.tail`/`downbeatGrid.tail.downbeatsSec`）はファイルの絶対タイムライン上に構築されており、この実行時オフセットを一切知らない。本 phase の tail 窓拡張（45→60秒）により、75-90秒程度の長さのトラックでこのプールが `#currentEntrySec` より前の候補を含みうるようになった——45秒窓では通常そこまで手前に候補が伸びなかった。ランカーがそのような候補を選んでしまうと、`#maybeStartCrossfade()` の `Math.max(0, exitStartSec - currentEntrySec)` によって `startSec` が0にクランプされ、B→C の遷移がプロモート直後に即座に due になり、トラックのほぼ全体をスキップしてしまう。
  - 修正: `player.js` に `excludeExitCandidatesBeforeEntry(analysis, currentEntrySec)`（新規、非公開関数）を追加し、`#maybeStartCrossfade()` が `outAnalysis` をランキングに渡す直前に、`phrases.tail`/`downbeatGrid.tail.downbeatsSec` から `sec <= currentEntrySec` の候補を除外するようにした。`currentEntrySec === 0`（プロモートされていない通常の現在トラック）のときは早期リターンし、余計なオブジェクト生成を避ける。
  - テスト: `src/player.acceptance.test.js` に、A→B で B を nonzero entry(5.0s) で昇格させたあと、B 自身の tail 候補プールに entry より手前(2.0s、高スコア)の候補と entry より後ろ(21.5s、低スコア)の唯一の有効な候補を両方仕込み、フィルタが無ければスコアの高い手前の候補が勝つ（`rankTransitionCandidates()` を直接叩くデバッグスクリプトで実測・較正済み——`scoreTransitionPair()` の `vocalSafety` 項が exit 位置とボーカルフロアとの間の margin もスコアするため、フィルタ対象の候補が実際にボーカル安全フィルタと得点の両方をすり抜けるよう `lastVocalEndSec=0` に調整する必要があった）ことを利用した回帰テストを追加した。アサーションは「一定時間内に発火しないこと」のようなタイミング依存ではなく、実際に発火した `crossfadestart` の `mixPlan.startSec`（採用された exit 候補の絶対ネイティブ秒——`normalizeTransitionPlan()` の `beatmix` 分岐参照）が有効な候補(21.5)と一致し、無効な候補(2.0)でないことを直接検証する——このテストの開発中、`bun test` 単体実行でのタイミングベースの初期設計（アーム・ループの200msタイマー発火が、フレーム読み取りの同期ループ中は完全にブロックされ、`await` で明け渡した瞬間まで先延ばしされるという、このサンドボックス環境固有の挙動により、いつ・どのポジションで最初の評価が起きるか予測できないこと）が判明したため、タイミングに依存しない形に設計し直した。修正を revert すると、期待どおり `startSec=2`(無効な候補)で失敗することを確認済み（revert-test-restore）。
- テスト: `bun run test:server` を再実行し、regression が無いことを確認した（769件中 761 pass / 4 fail はいずれも ffmpeg 未インストールによる既知の失敗のみ / 4 skip）。

### 追記: Codex レビュー対応（PR #52, round 2）

round 1 のプッシュ後、さらに2件の指摘が見つかった。1件は round 1 自身の P2 修正の見落とし、もう1件は round 1 の P1 修正と同じ「stale cache」パターンの別ルートでの再発。

- **P2: `excludeExitCandidatesBeforeEntry()` のフロアが `#currentEntrySec` だけでは不十分だった** — `MixStream.setCurrent()`（`mixStream.js`、beatmix/stem-mix プロモート時）は `positionSec` を0ではなく、そのクロスフェード中に既に消費した overlap 分（`fadeElapsedSec + incomingSkippedSec`）で初期化する。round 1 の修正は `#currentEntrySec`（ネイティブ・シーク位置）だけをフロアにしていたため、「entry offset より後だが、プロモート時点で既に overlap 消費済みの区間」にある候補を除外し損ねていた——そのような候補が選ばれると、結局同じ「即座に due になりトラックの大半をスキップする」症状が再発する。
  - 修正: 新しいプライベートフィールド `#currentEntryOverlapConsumedSec`（デフォルト0）を追加し、`#onCrossfadePromoted()`（本物のクロスフェード完了パス）でのみ、`this.#sessionTempo`（プロモート先トラックの tempo state に確定した直後）を使って `positionSec * tempoRatio`（ネイティブ秒に変換）を一度だけスナップショットする。他の2つの `#currentEntrySec` 代入箇所（`#playNextMixer()` の新規フレッシュ開始、snap-handoff——いずれも overlap を経由しないパス）は明示的に0のままにする。フロア自体はライブな `positionSec` から毎tick再計算するのではなく、`#currentEntrySec` と同様「プロモート時に一度だけ確定させる」設計にした——最初に試みたライブ再計算版（`currentEntrySec + 現在のpositionSec*ratio`）は、非プロモート（通常再生開始からの）トラック自身の候補にも同じフィルタを適用してしまい、このコードベースが元々許容している「アーム・ループの評価が多少遅れても、気づいた時点ですぐ発火する」という既存の設計（"a chained beatmix transition..." テストなど、複数の既存テストが依拠している挙動）を壊してしまうことが判明した（実装中に自分のテストの A→B レグ自体が発火しなくなる形で発覚）。
  - テスト: 既存の「a promoted track's exit-candidate pool excludes candidates before its own entry offset」テストに、entry offset(5.0s) より後だが overlap 消費区間(約8.02s、4-bar/8sのフェードにほぼ一致)より前にある3つ目の候補 `midConsumedInvalid`(8.0s, score 0.7) を追加した。この候補は round 1 のフィルタ（entry offsetのみ）を素通りしつつ、有効な唯一の候補(21.5s, score 0.5)より高スコアなので、round 1 だけでは依然としてこれが勝ってしまう。修正を revert（`#currentEntryOverlapConsumedSec` を常に0に固定）すると、期待どおり `startSec=8`（`midConsumedInvalid`）で失敗することを確認した（revert-test-restore）。
- **P2: `/api/playlists/mine/generate` が version チェックなしにキャッシュ済み解析を読んでいた** — round 1 で `ANALYSIS_VERSION` を上げた際、`internal.js`（`/internal/optimize-order` など）側の `loadAnalysis()` は既に `version < ANALYSIS_VERSION` を弾いていたが、`src/web/server/routes/playlists.js` の同名の別実装（MIX プレイリスト生成が `optimizeTrackOrder()` に渡す解析を読む側）にはこのチェックが一切なく、アップグレード前の version 3 の行を無期限に信用し続けてしまっていた。
  - 修正: `internal.js` の既存の predicate（`(parsed.version ?? 1) < ANALYSIS_VERSION` なら `null` を返す）をそのまま `playlists.js` の `loadAnalysis` にも適用した。
  - テスト: `playlists.test.js` に、stale な version（`ANALYSIS_VERSION - 1`）の行を仕込んでも `/api/playlists/mine/generate` が通常どおり成功することを確認するテストを追加した。ただし、このルートは `/internal/optimize-order`（`internal.test.js` の "probes the tempo backend once..." テストが使っている）と異なり、tempo backend の probe をルート経由で差し替えられる DI フックを持たないため、実際に順序が変わることまでは（本 PR の範囲では）検証していない——このテストが保証するのは「stale な行があってもクラッシュせず正常応答する」ことのみで、predicate 自体の正しさは `internal.js` 側の既存テストで証明済みのものを流用している。
- テスト: `bun run test:server` を再実行し、regression が無いことを確認した（770件中 762 pass / 4 fail はいずれも ffmpeg 未インストールによる既知の失敗のみ / 4 skip）。

## 実装ノート (Phase 9G)

§9 の Mix Zone Planner を実装した。完了条件（§17 9G）「1本のequal-power crossfadeではなく、複数bar eventでtransitionが進行する」を、stem-mix 経路（Phase 8 で導入済みの4-stem独立ゲインエンベロープ）に対する具体的なbar-event scheduleとして実装した——beatmix（非stem）経路の単一equal-powerクロスフェード自体は本phaseでは変更していない（stem-mixのみが per-stem envelope を持ち、bar-event に分解する対象になりうるため）。

### スコープの判断

§9.1/9.2 のドキュメントが示す完全な姿（`TransitionPlan v3` の `mixZone`/`events` に基づいて MixStream がゲイン計算そのものを駆動する、outgoing-instrumental-duck を含む5種類のイベント、Phase 9H/9I が前提とする hold/release・独立タイムラインとの統合）は、既存の `gainForStemPosition()`（hold→fadeの2区間エンベロープ、Phase 8 で実装・検証済み）を置き換えるほどの音声パイプラインの再設計を要し、本エージェント環境で安全に検証できる範囲を超える。今回は「①データモデルとして `mixZone`/`events` を導入し、②MixStream に実際に bar-clock を持たせて、そのスケジュールに沿って `mixzoneevent` を発火させる」という、完了条件が要求する「複数bar eventでtransitionが進行する」を文字通り満たす最小限の実装に絞った——ゲイン計算そのもの（音声波形）は Phase 8 から一切変更していない。Phase 9H（outgoing vocal hold/release）・9I（incoming vocal 独立タイムライン）は、この `events` schedule を土台にできる形で今回のPRを設計した。

### 実装箇所

- `src/audio/stemTransition.js`:
  - `buildMixZone(plan)`（新規）: §9.1 の `mixZone` オブジェクト（`startSec`/`durationSec`/`bars`/`beatsPerBar`/`targetBpm`）を、既存の `plan.outgoing.exitStartSec`/`plan.fadeSec`/`plan.sync`/`plan.targetBpm` からそのまま組み立てる。フィールドが無い（bare/legacy な plan）場合は `null` を埋める。
  - `buildTransitionEvents(plan, stems)`（新規）: §9.2 の `events` 配列を、`buildStemEnvelopes()` が既に計算している各stemの `startOffsetSec`/`fadeSec`（秒単位）を bar 単位に変換して構築する。`barSec = (60/targetBpm)*beatsPerBar` は `planBeatmixTransition()` が `fadeSec` を計算する際に使っているのと全く同じ式（`beatmixTransition.js` の `barSec = (60/targetBpm)*beatsPerBar`）を再利用しており、独自に定義し直してドリフトする余地がない。4種類のイベント:
    - `incoming-instrumental-start`（bar = `inInstrumental.startOffsetSec` を bar 変換したもの、常に0）
    - `outgoing-vocal-release`（bar = `outVocal.startOffsetSec + outVocal.fadeSec` を bar 変換——outVocal が無音に達する時点）
    - `incoming-vocal-handoff`（bar = `inVocal.startOffsetSec` を bar 変換——inVocal がフェードインを始める時点）
    - `bass-swap`（bar = 既存の `plan.eq.swapBar`、Phase 7C から変更なし）
    §9.2 の例にある `outgoing-instrumental-duck` は今回のenvelopeモデルには対応する区別された状態がない（outInstrumental は既に bar 0 からフェードを始めており、`incoming-instrumental-start` と同一 bar の重複イベントになってしまうため）ため意図的に省略した。`plan.sync`/`plan.targetBpm` が無ければ（bar clock を導出できない）空配列を返す——呼び出し元は「スケジュール無し」として扱う。
  - `planStemTransition()`: eligible な plan の返り値に `mixZone: buildMixZone(plan)` / `events: buildTransitionEvents(plan, stems)` を追加した。
- `src/player.js` `normalizeTransitionPlan()` の `stem-mix` 分岐: `rawPlan.mixZone`/`rawPlan.events` を `mixPlan`（`MixStream.startStemCrossfade()` が直接読む形）にそのまま引き渡すようにした。`events` は空配列ではなく `undefined` を渡す（`rawPlan.events?.length ? rawPlan.events : undefined`）——`MixStream` 側の「スケジュール無し」ガードが「未定義」と「空配列」を区別せず同じ扱いにできるようにするため。
- `src/audio/mixStream.js`:
  - `startStemCrossfade()`: `#stemCrossfade` の内部状態に `events`（`plan.events` の配列、無ければ `null`）、`mixZone`、`nextEventIndex`（次に発火すべきイベントのインデックス、0から開始）を追加した。
  - `#fireDueMixZoneEvents()`（新規、非公開メソッド）: 毎tick（`#fadeElapsedSec` を進めた直後）呼び出され、`barSec = mixZone.durationSec / mixZone.bars` で bar→秒 変換し、`#fadeElapsedSec` が到達・通過した未発火のイベントを `nextEventIndex` から順に、1つずつ、ちょうど1回だけ `'mixzoneevent'` として emit する。`events`/`mixZone` が無い（従来の stem-mix plan、または beatmix/legacy plan）場合は何もしない——完全に後方互換。
  - `#tickStemCrossfade()`（既存の `#readStemCrossfadeFrame()` 内、ゲイン計算のすぐ後）から `#fireDueMixZoneEvents()` を呼ぶよう1行追加した。ゲイン計算自体（`gainForStemPosition()` への呼び出し）は一切変更していない——`events` はあくまで「今どのbar-eventを通過したか」を外部に知らせる観測レイヤーで、音声そのものの計算経路には介在しない。
- テスト:
  - `stemTransition.test.js`: `buildMixZone()`/`buildTransitionEvents()` の単体テスト（bar変換の正しさ、`bass-swap` 省略ケース、bar-clockデータ欠如時の空配列フォールバック）、および `planStemTransition()` が実際に populated な `mixZone`/`events` を返すことを確認するテストを追加した。
  - `mixStream.test.js`: `startStemCrossfade()` に `mixZone`/`events` を含む plan を渡すと、スケジュールされた3つのイベントが `#fadeElapsedSec` の進行に応じて正しい順序で・それぞれ1回だけ `'mixzoneevent'` として発火することを確認するテストと、`mixZone`/`events` を含まない（従来どおりの）plan では一切発火しないことを確認するテストを追加した。
  - `bun run test:server` を再実行し、regression が無いことを確認した（778件中 770 pass / 4 fail はいずれも ffmpeg 未インストールによる既知の失敗のみ / 4 skip）。`src/audio/mixStream.test.js` 単体実行では既知の7件のタイミング依存失敗（このサンドボックス環境固有、`bun test` 実行時のみ発生——`bun run test:server` が実際に使う node 標準テストランナーでは発生しない、Phase 9F でも確認済みの既知差異）が出るが、変更前の baseline でも同一の7件が同一の理由で落ちることを確認済み。
  - revert-test-restore: `#fireDueMixZoneEvents()` の呼び出しを一時的にコメントアウトすると新規テストが期待どおり失敗すること（`fired` が空配列のまま）、`planStemTransition()` の `mixZone`/`events` 代入を一時的に `null`/`[]` に固定すると新規テストが期待どおり失敗すること（`TypeError: null is not an object`）を確認したうえで復元した。

### 未決事項 / 既知の制約

- **ゲイン計算自体はまだ event-driven ではない（round 2 で再確認・訂正）**: round 1 で `deriveStemEnvelopesFromEvents()` を追加し、`events`/`mixZone` が揃っているとき `MixStream` は `plan.stems` ではなくこの関数の返り値からゲインエンベロープを組み立てるようにした——これ自体は事実で、`plan.stems` と `events`/`mixZone` をわざと食い違わせたテスト fixture でも正しく `events` 側が使われることをテストで確認済み。しかし round 1 のノートで「解消済み」としたのは不正確だった——round 2 の Codex レビューが正しく指摘したとおり、`planStemTransition()` の実際の呼び出し経路では `events`（`buildTransitionEvents(plan, stems)`）は常に同じ `stems`（`buildStemEnvelopes()` の返り値）から生成され、`deriveStemEnvelopesFromEvents()` はその `events` から（丸め誤差を除き）全く同じ数値を再構築するだけなので、実運用のあらゆる呼び出しにおいて音声再生の挙動は Phase 8 から一切変化していない。「`events` が実際にゲイン計算を駆動する」という主張はコードのデータフロー的には真だが、「複数の異なるステージが実際に異なる音として聞こえる」という完了条件の実質的な意図は round 1 の修正だけでは満たされていない——下記「追記: Codex レビュー対応（PR #53, round 2）」参照。
- **beatmix（非stem）経路は対象外**: 単一の equal-power crossfade（`mixPlan.curve`）を使う plain beatmix 遷移には `mixZone`/`events` を付与していない——beatmixには per-stem envelope が存在せず、bar-eventに分解する対象そのものがないため。stem-mix が利用可能な場合にのみ意味を持つ機能拡張として実装した。
- **`outgoing-instrumental-duck` イベントは未実装**: §9.2 の例が挙げる5種類目のイベント。現行のenvelopeモデルにはoutInstrumentalの「duck」と「fade」を区別する独立した状態がないため、実装しないままにしてある（上記参照）。
- **実運用での聴感評価は未実施**: 既存フェーズのノートと同様、`mixzoneevent` の発火タイミングが実際の楽曲・実運用でどれだけ「意味のある」bar位置に対応しているか（特にPhase 9H/9Iがこれを使い始めた際の効果）は実音源・実Discordセッションでの確認が必要で、本エージェント環境では実施できない。

### 完了条件（§9/§17 9G 相当）

- [x] TransitionPlan v3 の `mixZone`（§9.1）を stem-mix plan に実装した（`buildMixZone()`）
- [x] TransitionPlan v3 の `events` 配列（§9.2）を stem-mix plan に実装した（`buildTransitionEvents()`、bar-clockデータ欠如時は空配列にフォールバック）
- [x] MixStream が bar clock を持ち、stem crossfade の進行に応じて `events` のスケジュールに沿って `'mixzoneevent'` を実際に発火する（`#fireDueMixZoneEvents()`）——「1本のequal-power crossfadeではなく、複数bar eventでtransitionが進行する」という完了条件を、実際に発火する観測イベント列として満たした
- [x] 既存のゲイン計算（Phase 8）・既存テストへの regression が無いことを確認した（`bun run test:server`: 778件中770 pass、既知の4件のみ fail）
- [ ] ゲイン計算そのものを `events` ベースで再設計し、各イベントが実際に異なる音として聞こえる形にする（round 1 でデータフロー上は `events` 駆動にしたが、round 2 の Codex レビューで round-trip が実運用では常に無変化であることが判明——上記未決事項・下記「追記: round 2」参照。Phase 9H/9I 以降のスコープ）
- [ ] `outgoing-instrumental-duck` イベントの実装（上記未決事項参照）
- [ ] 実運用での聴感評価（上記未決事項参照）

### 追記: Codex レビュー対応（PR #53, round 1）

Codex から3件の指摘を受けた（P1が1件、P2が2件）。いずれも妥当な指摘と判断し、修正した。

- **P1: `events`/`mixZone` が実際のゲイン計算を駆動していない**（前回ノートの「未決事項」で自ら認めていた制約そのもの）。`events` は `mixzoneevent` を発火するだけの観測レイヤーで、`#readStemCrossfadeFrame()` は相変わらず `plan.stems`（`buildStemEnvelopes()` の生の秒数）を直接読んでおり、`events` の値を変えても実際に混ざる音声は変化しなかった。`docs/mix-transition-phase9.md` 側で明示的に「未決事項」と書いていたが、指摘を受けて改めて検討した結果、既存の `gainForStemPosition()`（hold→fadeの2区間エンベロープ、Phase 8 で実装・検証済み）をそのまま使い続けられる安全な形で実装できると判断し、以下を追加した:
  - `stemTransition.js` に `deriveStemEnvelopesFromEvents(events, mixZone, curve)`（新規）: `buildTransitionEvents()` の逆変換——`events` 配列 + `mixZone` から、`gainForStemPosition()` がそのまま消費できる4種類のstemエンベロープ記述子（`{role, curve, startOffsetSec, fadeSec}`）を再構築する。`incoming-instrumental-start`/`outgoing-vocal-release`/`outgoing-vocal-silent`/`incoming-vocal-handoff` の各イベントのbar位置を `findEventBar()`（新規ヘルパー、該当イベントが見つからなければ妥当なfallback bar——windowの開始または終了——を返す）で引き、`toSec(bar) = bar * (mixZone.durationSec / mixZone.bars)` で秒に変換する。
  - `mixStream.js` の `startStemCrossfade()`: `#stemCrossfade.stems` を、`events`/`mixZone` が両方揃っている（`mixZone.bars > 0` かつ `mixZone.durationSec > 0`）ときは `deriveStemEnvelopesFromEvents()` の返り値から、それ以外（従来の stem-mix plan、`events` を持たない hand-built なテスト plan）では従来どおり `plan.stems` から組み立てるよう変更した。`gainForStemPosition()` 自体の実装・呼び出し箇所（`#readStemCrossfadeFrame()`）は一切変更していない——入力となるエンベロープの「出どころ」だけが `events` 経由に置き換わった。
  - この設計により、`events`/`mixZone` を持たない全ての既存テスト・呼び出し元（beatmix、Phase 8 時代の hand-built test plan 等）は完全に従来どおりの経路（`plan.stems` 直読み）のまま動作する——後方互換を壊さない。
  - 検証: `stemTransition.test.js` に `deriveStemEnvelopesFromEvents()` の round-trip テスト（既知のstemエンベロープから `buildTransitionEvents()` で `events` を作り、`deriveStemEnvelopesFromEvents()` で元の秒数値に戻ることを確認、誤差 1e-4 未満）を追加した。`mixStream.test.js` には `plan.stems` と `events`/`mixZone` が意図的に異なる値になるよう仕組んだ plan で `startStemCrossfade()` を実行し、実際にミックスされたPCMフレームが `deriveStemEnvelopesFromEvents()` 由来のゲイン（`plan.stems` 由来ではない）と一致することを直接検証するテストを追加した——`events`/`mixZone` が実際にゲイン計算を駆動していることの直接証拠。revert-test-restore: `stems` の代入を一時的に `plan.stems` 固定に戻すと、この新規テストが期待どおり失敗する（`gotFrame` が `expectedFromPlanStemsOnly` と一致してしまう）ことを確認したうえで復元した。

- **P2: `outgoing-vocal-release` イベントのタイミングが不正確**。前回の実装では `outgoing-vocal-release` を outVocal の**フェードが完了した時点**（`startOffsetSec + fadeSec`）に配置していたが、イベント名の意味（「解放し始める」＝フェード**開始**）と食い違っていた——実際にはフェード開始時点を表すべきイベントが、フェード完了時点を指していた。修正として `outgoing-vocal-release` はフェード**開始**時点（`startOffsetSec`）に、新規イベント `outgoing-vocal-silent` をフェード**完了**時点（`startOffsetSec + fadeSec`）に分離した——「解放し始める」と「無音に達した」は別のbar位置になり得る（実際、多くのケースでなる）ため、2つの区別されたイベントとして表現する方が§9.2の意図に忠実と判断した。`stemTransition.test.js` の既存テスト（`buildTransitionEvents converts each stem envelope timestamp...`）のfixtureを、release開始とsilent到達が異なるbarになるよう更新し（`startOffsetSec:1, fadeSec:3` → release=bar 0.5, silent=bar 2）、両イベントがそれぞれ正しいbarで出力されることを確認した。revert-test-restore: `outgoing-vocal-release` のbar計算を一時的に旧来の「フェード完了時点」に戻すと、この更新後のテストと新規の round-trip テストの両方が期待どおり失敗することを確認したうえで復元した。

- **P2: `#fireDueMixZoneEvents()` の null-deref クラッシュ**。旧実装は `nextEventIndex` を `this.#stemCrossfade` からループ開始時に取り出し、ループ中はローカル変数で回し、ループ終了後に `this.#stemCrossfade.nextEventIndex = index` として書き戻していた。しかし `this.emit('mixzoneevent', ...)` は同期的にリスナーを呼び出すため、そのリスナーが `dropCurrent()`/`endMixer()` 等を呼んで `#stemCrossfade` を `null` にした場合、ループ終了後の書き戻しが `null` に対するプロパティ代入となり `TypeError` で mixer stream 全体が落ちる——mixzoneevent を消費する側の正当な操作（例: このイベントをトリガに次の曲へスキップする、等）が mixer 自体をクラッシュさせてしまう。修正として `crossfade` オブジェクトの参照を最初に一度だけ捕まえ、以降は一貫してそのオブジェクトを直接ミューテートする（`this.#stemCrossfade` への書き戻しを二度と行わない）方式に変更し、加えて `nextEventIndex` の加算を `emit()` の**前**に行い（emit後に例外/再入があっても取りこぼしなく1回のみ発火したことになる）、`emit()` の直後に `this.#stemCrossfade !== crossfade` をチェックしてリスナーが同期的にcrossfadeを破棄した場合はループを即座に打ち切る（もはや存在しないcrossfadeについて記述し続けない）ガードを追加した。`mixStream.test.js` に、`mixzoneevent` リスナーの中で同期的に `mix.dropCurrent()` を呼ぶ回帰テストを追加し、（1）例外・`'error'` イベントが一切発生しないこと、（2）テアダウン後のイベントは発火せず、テアダウン時点で処理中だった1件のみが発火することを確認した。revert-test-restore: `#fireDueMixZoneEvents()` を旧来の「ループ後に書き戻す」実装に一時的に戻すと、この新規テストが `TypeError: null is not an object` で期待どおり失敗することを確認したうえで復元した。

検証: `bun test src/audio/stemTransition.test.js`（17 pass / 0 fail、うち3件が今回追加）、`bun test src/audio/mixStream.test.js`（31 pass中24 pass・7 failは前回ノート記載済みの既知タイミング依存flake、うち2件が今回追加でともにpass）、`bun run test:server` を再実行し regression が無いことを確認した。

### 追記: Codex レビュー対応（PR #53, round 2）

round 1 の修正（commit `f87ad0e`）に対し、Codex から新たに2件の指摘を受けた（P1が1件、P2が1件）。

- **P1: `deriveStemEnvelopesFromEvents()` は既存の連続フェードを再構築しているだけで、実運用の音声再生は変化していない**。round 1 のノートでは「`events`/`mixZone` が実際のゲイン計算を駆動するようになった」と書いたが、これは正確には「コードのデータフロー上、`MixStream` が `plan.stems` ではなく `events`/`mixZone` から導出した値を読むようになった」という意味に過ぎなかった。round 1 の検証テストは `plan.stems` と `events`/`mixZone` を**意図的に食い違わせた**フィクスチャで「`events` 側が使われる」ことを証明したが、これは実運用のプランが取り得ない状況だった——`planStemTransition()`（`src/audio/stemTransition.js:282-289`）を確認すると、`stems`（`buildStemEnvelopes()` の返り値）と `events`（`buildTransitionEvents(plan, stems)`）は常に同じ `stems` オブジェクトから生成されており、両者が食い違うことは実際には起こり得ない。したがって `deriveStemEnvelopesFromEvents()` が `events`/`mixZone` から再構築する値は、（bar丸めによる 1e-6 未満の誤差を除き）`buildStemEnvelopes()` が最初に計算した値と常に一致し、実運用のあらゆる呼び出しにおいてミックスされる音声は Phase 8 から一切変化していない——round-tripが可逆であること自体が、new behaviorを一切導入していないことの裏返しだった。Codex の指摘は正確で、round 1 のノートの「解消済み」という記述は誤りだったため、上記「未決事項」・「完了条件」を訂正した（このコミットに含む）。
  - **対応方針**: これを「小さな修正」で埋めることはできないと判断した——各イベント（`incoming-instrumental-start`/`outgoing-vocal-release`/`outgoing-vocal-silent`/`incoming-vocal-handoff`/`bass-swap`）が実際に異なる音として区別できるようにするには、「どのステージで何が起きるべきか」（例: `outgoing-vocal-release` の瞬間に外側のvocalをフェードではなくホールドしてから離す、`incoming-vocal-handoff` を境に独立したタイムラインでinVocalを立ち上げる、等）を新たに設計する必要があり、これはまさに Phase 9H（outgoing vocal hold/release envelope、§10）・Phase 9I（incoming vocal 独立タイムライン、§11）としてロードマップに既に計画されているスコープそのものである。9G の中でこれを先取りして実装すると、これまで慎重に踏んできた「Phase 8 の実証済み `gainForStemPosition()` を壊さない」というリスク境界を越えることになり、本エージェント環境で安全に検証しきれない音声パイプラインの再設計に踏み込んでしまう。round 1 → round 2 で指摘の実質が「イベントがコード上ゲインを駆動していない」から「イベントは駆動しているが実運用では何も変えていない」へと深まったのは、根っこが同じ一つの設計上の制約（Phase 8 のエンベロープモデルをそのまま使う限り、イベントは観測用の再エンコードにしかなり得ない）に起因しており、9G の枠内でのコード修正を重ねても収束しないと判断した。そのため今回はコードの再修正はせず、この分析結果を PR コメントで Codex に返信し、上記ドキュメントを訂正するに留めた。実際の per-event 音声差別化は Phase 9H/9I の作業として明示的に引き継ぐ。
  - `deriveStemEnvelopesFromEvents()`/round 1 の変更自体は撤回していない——`events`/`mixZone` を実際の入力として読む経路として正しく実装されており、Phase 9H/9I がイベントごとに異なる値（例えば `outgoing-vocal-release` と `outgoing-vocal-silent` の間で意図的に異なるcurveを使う等）を `events` に埋め込むようになれば、その差は今の実装でも自動的に音声へ反映される——「土台」としての価値はある。round 2 が明らかにしたのは、9G 単体では埋め込まれる値そのものが常に同一になるため差が生まれない、という点のみ。

- **P2: `endMixer()` を同期的に呼ぶ `mixzoneevent` リスナーが `ERR_STREAM_PUSH_AFTER_EOF` を引き起こす**。round 1 で修正した null-deref（`#fireDueMixZoneEvents()` 内で `this.#stemCrossfade` への書き戻しが `null` に対して行われる問題）は解消されていたが、その一段上——`#tryPushFrame()`（`mixStream.js`）——に別の同種の問題が残っていた。`endMixer()` は `#destroyed` を立てたうえで自ら `this.push(null)`（EOF）を呼ぶが、`#tryPushFrame()` は `const frame = this.#readFrame();` を実行した**後**に `this.#destroyed` を再チェックしていなかったため、`#readFrame()` の内部（`#readStemCrossfadeFrame()` → `#fireDueMixZoneEvents()` → `emit('mixzoneevent')` → リスナーが同期的に `endMixer()` を呼ぶ）で EOF が送出された直後でも、呼び出し元は構わず `this.push(frame)` を実行してしまい、Node が `ERR_STREAM_PUSH_AFTER_EOF` を投げてストリーム自体を破壊していた。修正として `#tryPushFrame()` の `const frame = this.#readFrame();` の直後に `if (this.#destroyed) return;` を追加し、読み取り中に同期的にテアダウンされた場合はそこで即座に処理を打ち切るようにした。`mixStream.test.js` に、`mixzoneevent` リスナーの中で同期的に `mix.endMixer()` を呼ぶ回帰テストを追加し、`'error'` イベントが一切発生しないことを確認した。revert-test-restore: 追加した `if (this.#destroyed) return;` を一時的に削除すると、この新規テストが `ERR_STREAM_PUSH_AFTER_EOF` で期待どおり失敗する（実際に `stream.push() after EOF` エラーを再現した）ことを確認したうえで復元した。

検証: `bun test src/audio/mixStream.test.js`（32 pass中25 pass・7 failは既知のタイミング依存flake、うち2件が今回追加でともにpass）、`bun run test:server` を再実行し regression が無いことを確認した。


## 実装ノート (Phase 9H)

§10 の Outgoing Vocal Hold/Release を実装した。§10.1 の問題提起（outVocal がtransition開始と同時にフェードアウトを始めるため、最後の歌唱がフェード途中で弱くなって聞こえる）に対し、§10.2/§10.3 が示す「ほぼ全期間 hold → 直前の短い release」という envelope 形状を、既存の `gainForStemPosition()`（hold→fadeの2区間モデル、Phase 8 で実装・検証済み）にそのまま乗せる形で実装した——`gainForStemPosition()` 自体・その呼び出し箇所は一切変更していない。

### 実装箇所

- `src/audio/stemTransition.js`:
  - `DEFAULT_OUTVOCAL_RELEASE_SEC`（新規定数、`0.5`）: §10.3 の worked example (`releaseSec: 0.5`) をそのままデフォルト値として採用した。§10.4 は 200〜800ms のレンジを示しているが、固定デフォルトを使うことでテスト・挙動の再現性を保った——将来的に楽曲ごとに変える必要が出れば `buildStemEnvelopes()` の `outVocalReleaseSec` オプションで上書きできる。
  - `buildStemEnvelopes()`: 従来 `outVocalFadeSec`（= 残り native vocal tail を playback 秒に換算した時間）をそのまま `outVocal.fadeSec` として使い `startOffsetSec: 0` から即座にフェードしていた箇所を変更した。同じ時間を `outVocalWindowSec`（"無音に達するまでの時間"、Phase 8 の `outVocalFadeSec` と数値的に同一）として保持したうえで、`releaseSec = clamp(outVocalReleaseSec, 0, outVocalWindowSec)`（window が release のデフォルト値より短い場合はwindow全体に縮退——holdSecが負にならないためのガード）、`holdSec = outVocalWindowSec - releaseSec` を計算し、`outVocal: { startOffsetSec: holdSec, fadeSec: releaseSec, ... }` を返すようにした。「無音に達する瞬間」（`holdSec + releaseSec = outVocalWindowSec`）自体は Phase 8 から不変のため、`inVocalDelaySec`（`outVocalWindowSec + vocalCrossoverMarginSec` を使う既存の計算）・`estimateInVocalFadeSec()` は無変更——incoming vocal のタイミングロジックには影響しない。
  - `buildTransitionEvents()`: コード自体の変更はなし（`stems.outVocal.startOffsetSec`/`fadeSec` を読むだけなので、Phase 9H の変更は自動的に反映される）。ただし `'outgoing-vocal-release'` イベントの docstring を、「Phase 9H 導入前は常に bar 0」から「Phase 9H 以降は hold 境界のbar（= ウィンドウのほぼ終盤）」に更新した。
- テスト（`stemTransition.test.js`）:
  - 既存3件（`outVocal fades out over exactly...`/`tail is converted from native to playback seconds...`/`clamps inVocal to a zero-length window...`）の fixture・アサーションを新しい hold/release セマンティクスに合わせて更新した（`outVocal.fadeSec` が「無音までの全時間」ではなく「release時間のみ」になったため）。
  - 新規2件を追加: (1) window が `DEFAULT_OUTVOCAL_RELEASE_SEC` より短い場合に release がwindow全体へ縮退し hold が負にならないことを確認するテスト、(2) `gainForStemPosition()` を実際に呼び出し、hold区間（0〜6.49秒）で常にgain=1、release区間の途中で0と1の間、windowの終端でgain=0になることを確認する回帰テスト——§10.1 の問題提起そのもの（連続フェードだと中間点で既に~30%減衰している）が解消されていることの直接証拠。

### 未決事項 / 既知の制約

- **「last vocal phrase start」の専用検出は行っていない**: §10.4 のプランナー・スケッチは「最後のvocal phraseの開始」を起点とした設計を示唆しているが、既存の解析パイプライン（`vocalActivity.js`）は `lastVocalEndSec`（最後にvocalが検出された終端）と `vocalGaps`（1.5秒以上の無音区間）のみを提供し、phrase単位の開始点を明示的には持たない。今回は新しい解析ステップを追加せず、既存の `outVocalTailNativeSec`（= exit point から `lastVocalEndSec` までの時間、Phase 8 から不変）をそのまま「hold+release の合計時間」として使い、その中で release だけを短く切り出す設計にした——`exitStartSec` 自体が vocal-safe な点に近いところで選ばれる前提（`beatmixTransition.js` の vocalFloor ゲート）に立てば、この区間はほぼ「最後のvocal phraseの範囲」と一致すると考えられるが、厳密な phrase 境界検出ではない。より精緻な phrase 単位の制御が必要になれば、`vocalGaps` を使って `lastVocalEndSec` 直前の gap の終端を「phrase start」として明示的に検出する拡張が考えられる。
- **releaseSec は固定デフォルト**: §10.4 が示す 200〜800ms のレンジ内で楽曲ごとに変化させる仕組みは実装していない。実運用での聴感評価を踏まえて可変にする価値があるかは今後の判断に委ねる。
- **実運用での聴感評価は未実施**: 既存フェーズのノートと同様、本エージェント環境では実施できない。

### 完了条件（§10/§17 9H 相当）

- [x] outVocal envelope を `{ holdSec, releaseSec, curve }`（実装上は既存の `{ startOffsetSec, fadeSec, curve }` 形状のまま、意味論だけ hold/release に変更）に変更した
- [x] hold は「無音に達するまでの残り時間（native vocal tail）」そのもの、release はその**後に**§10.3 の例に沿って固定 0.5秒追加（transition window の残り時間が足りない場合はその範囲へ縮退——round 2 で訂正、下記参照）
- [x] 既存のゲイン計算関数（`gainForStemPosition()`）に regression が無いことを確認した。incoming vocal のタイミングロジック（`inVocalDelaySec`/`estimateInVocalFadeSec()`）は release 分を追加で考慮するよう更新し、`planStemTransition()` の candidate search（pairFilter）と最終envelopeビルドの両方が同じ計算を共有するようにした（round 2、下記参照）。`bun run test:server`: 785件中777 pass、既知の4件のみ fail
- [ ] 「last vocal phrase start」の専用検出（上記未決事項参照、必要になれば次フェーズ以降）
- [ ] release時間を楽曲ごとに可変にする（上記未決事項参照）
- [ ] 実運用での聴感評価（上記未決事項参照）

### 追記: Codex レビュー対応（PR #54, round 1）

Codex から P2 の指摘を1件受けた——「outVocal は `lastVocalEndSec` 直前の `releaseSec` 分だけ、まだ実際に歌っている区間で減衰し始め、`lastVocalEndSec`（実際の歌唱終了と一致するタイムスタンプ）に到達した時点で既に無音に達している。これは §10.4 の『hold → phrase終了 → short release』という順序（release は phrase終了の**後**に来るべき）に反する」という指摘。

これは正当な指摘だった。round 1 の実装は `outVocalWindowSec`（= "無音に達するまでの残り時間"、Phase 8 の `outVocalFadeSec` と数値的に同一）を hold と release に**分割**していたため、release の分だけ hold が短くなり、結果として無音に達する瞬間自体は変わらないまま（Phase 8 と同じ `lastVocalEndSec` の位置）——release区間がちょうど実際の歌唱の最後の0.5秒と重なってしまい、§10.1 が問題視していた「最後の歌唱が減衰して聞こえる」という欠陥を、期間を短くしただけで実質的に再現していた。

修正: hold の長さを Phase 8 の `outVocalFadeSec` と同じ計算のまま（= 残り native vocal tail をそのまま）にし、release はその**後に追加**する時間として扱うよう変更した（`outVocalHoldRelease()` という共有ヘルパーに切り出し）。これにより無音に達する瞬間は `holdSec + releaseSec`（Phase 8 の元の時間より最大 `releaseSec` 分だけ後ろにずれる）となり、outVocal は実際の歌唱が終わる瞬間（`lastVocalEndSec`）まで完全に減衰なしで鳴り続ける。release は transition window（`fadeSec`）の残り時間でクランプされ、hold が window の端まで達している場合は release が 0 に縮退する（既存の Phase 8 クランプと同じ思想）。また、hold が 0（= exit point が既に vocal-safe で歌唱が残っていない）の場合は release も 0 にするガードを追加した——歌唱が無いのに release を追加すると inVocal の開始が無意味に遅れてしまうため（Phase 8 の「vocal-safe なら inVocal はほぼ即座に始められる」という挙動を保持）。

無音に達する瞬間が後ろにずれたことに伴い、`inVocalDelaySec`（`buildStemEnvelopes()`）と `estimateInVocalFadeSec()`（`planStemTransition()` の pairFilter が候補探索時に使う、同じ計算の双子）の両方を `holdSec + releaseSec + vocalCrossoverMarginSec` を使うよう更新し、両者が同じ `outVocalHoldRelease()` ヘルパーを共有することで、探索時に検証した inVocal の余地と最終envelopeが食い違わないようにした。`planStemTransition()` にも `outVocalReleaseSec` オプションを追加し、`buildStemEnvelopes()` への forwarding と pairFilter 双方に一貫して渡るようにした。

検証: `stemTransition.test.js` の既存6件のfixture/アサーションを新しいhold/releaseセマンティクスに合わせて更新し、新規2件（release が transition window の端でクランプされるケース、release の余地が全く無いケース）を追加した（計20件、全pass）。revert-test-restore: `outVocalHoldRelease()` を一時的に旧実装（release を hold から差し引く）に戻すと、更新後のテスト6件が期待どおり失敗することを確認したうえで復元した。

副作用として、`player.acceptance.test.js` の既存回帰テスト（PR #46 round 6, "TRACK loop mode's stem-mix -> bestNonStemPlan downgrade..."）が1件レグレッションした——このテストは stem-mix の pairFilter が「際どく」通過するよう手動でチューニングされた fixture（inVocal の余地がちょうど閾値 `MIN_MEANINGFUL_INVOCAL_FADE_SEC` を僅かに超える程度）を使っており、release の追加分だけ余地が減ったことでその境界を割り込み、テストの前提（stem-mix が一旦選ばれてから downgrade する）自体が成立しなくなっていた。これはPhase 9Hの意図した挙動変化（vocalを完全に鳴らし切るには、以前より少し多くのオーバーラップ時間が必要になる）が正しく反映された結果であり、fixture の `lastVocalEndSec` を `8.0` から `7.5` に0.5秒(= release分)ずらすことで、テストが検証したかった余地（0.8秒）を回復し、テスト自体の意図（downgrade時のreport.exit再構築の検証）は変更せずに済ませた。

検証: `bun test src/audio/stemTransition.test.js`（20/20 pass）、`node --test src/player.acceptance.test.js`（72 pass / 1 skip、0 fail）、`bun run test:server`（785件中777 pass、既知の4件のみ fail）。



## 実装ノート (Phase 9I) — 実装を見送り、調査結果のみ記録

§11 の Incoming Vocal Independent Timeline を実装したが、Codex レビュー（PR #55）で3件の構造的な問題（P1が3件）を指摘され、そのうち1件（後述の「問題2」）は小さなパッチでは解決できない、実装方式そのものに起因する根本的な矛盾であると判断したため、**コード変更を全て revert し、調査結果と設計上の制約のみをここに記録する**。Phase 9I は未完了のまま次フェーズ（9J）に進む。

### 試した実装

§11.1 の問題提起（incoming vocal が instrumental と同じタイムラインで再生され、gain=0 の間も PCM を消費するため、フェードインした瞬間に「歌詞の途中から急に聞こえる」）に対し、incoming vocal の file source だけを、その"自然な発声開始位置"（`firstVocalStartSec`、native秒）から hold 時間ぶんだけ手前に seek する方式を実装した（`incomingVocalSeekSec()`、`src/player.js`）。instrumental・`incoming.full`（stem window終了後の継続ソース）は変更せず、従来どおり `entrySec` に seek する。MixStream の読み取りループ自体は変更していない——4stem 全てを毎tick、crossfade開始（tick 0）から連続して読み続ける Phase 8 の挙動をそのまま利用し、vocal だけ読み取り開始位置をずらすことで、hold 時間が経過してgainが立ち上がる瞬間にちょうど `firstVocalStartSec` の位置に到達するようにした。

### Codex レビューで指摘された3件の問題（PR #55）

- **問題1（P1）: seek後にfadeウィンドウ全体をカバーするだけのnative音声が残っている保証がない**。`firstVocalStartSec` が track の終盤に近いと、そこから `durationSec` までの残り時間が `(fadeSec - holdSec) * tempoRatio` より短くなり得る（実際、このPRが追加したテストのfixture自体がこの状況——12秒のtrackを8.3秒にseekし、8秒のfadeを要求——を再現していた）。この場合、vocal stream はwindowの途中でEOFに達し、Phase 8 の既存の per-stem exhaustion handling（`#readStemCrossfadeFrame()` のsilence置換）が発動して、promotionの前に vocal が再び無音になってしまう。
- **問題3（P1）: backward seekがunderflow（0にクランプ）したときvocalの開始位置がずれる**。`firstVocalStartSec < holdSec * tempoRatio` の場合、`max(0, ...)` によってseek位置が0にクランプされるが、MixStreamは相変わらずtick 0から連続してvocalを読み続けるため、hold終了時点での読み取り位置は `0 + holdSec * tempoRatio`（native）——`firstVocalStartSec` を通り過ぎてしまっている。結局「歌詞の途中から聞こえる」問題を、位置は違えど再現してしまう。
- **問題2（P1、最も本質的）: `incoming.full`（promotion後の継続ソース）とvocal stemのnativeタイムラインが乖離し、promotion（stem-mixからincoming.fullへの切り替え）の瞬間に歌詞が飛ぶ/繰り返す**。`incoming.full` は `entrySec` にseekされ、stem windowの間ずっと（`#readStemCrossfadeFrame()` から）他の3stemとは独立して継続的にdrainされ続ける（`mixStream.js`の`#incomingStemFramesRead`まわり）。promotion時、`#current` はこの「ずっと自走していた」`incoming.full` にそのまま差し替わる。vocal stem が `entrySec` と異なる位置にseekされている（=このPhase 9Iの意図そのもの）場合、promotion時点でのvocalのnative位置（`vocalSeekSec + (fadeSec-holdSec)*tempoRatio` 相当）は、`incoming.full` のnative位置（`entrySec + fadeSec*tempoRatio` 相当）と一致しない。両者が一致するのは `vocalSeekSec === entrySec`（=独立seekを行わない、Phase 8そのまま）のときだけ——つまり、このPhase 9Iが実現しようとした「独立タイムライン」という発想自体が、promotion後にそれを一本の継続ソースへ回収する既存アーキテクチャと本質的に衝突している。

### なぜ小さなパッチで直せないか

問題1・3はそれぞれ独立に対処可能（room check を足す、あるいは MixStream 側で "audibleStartBar まで一切readしない" よう変更する）だが、問題2はどちらの対処をしても解消しない。検討した代替案:

- **vocal を entrySec にseekしたまま、hold中は"discard-catch-up"（読み捨てて先送りする）方式にする**: 数式を展開すると、これは元の"backward seek"と最終的に到達するnative位置が完全に同一になる（`entrySec` から `firstVocalStartSec - holdSec*tempoRatio` まで読み捨てるのと、最初からその位置にseekするのとで、promotion時点のnative位置は変わらない）。問題2は解消しない。
- **`incoming.full` の側をvocalのnative位置に合わせてseekし直す**: `incoming.full` は vocal と instrumental の両方を含む完全なmixなので、これをvocal側の位置に合わせると、今度は instrumental 側が同じ問題（乖離・ジャンプ）を起こす——問題をvocalからinstrumentalへ移すだけで、根本解決にならない。
- **hold区間でvocalに micro-tempo（速度の微調整）をかけてpromotion時点までにネイティブ位置を追いつかせる**: 理論上は両立可能だが、既存の macro tempoFilter（rubberband等）の上にさらに動的な速度変化を重ねる必要があり、ピッチ/アーティファクトの制御を含めて実装・検証コストが大きく、本エージェント環境で安全に検証しきれる範囲を超える。

いずれも、Phase 8で慎重に積み上げてきた MixStream の lockstep 前提（`incoming.full` を含む全ソースが「promotion時点で自然に synchronize している」という暗黙の不変条件）そのものに手を入れる必要があり、"seekだけを変える"という当初のリスク低減方針では実現できないと判断した。

### revert した内容

- `src/player.js`: `incomingVocalSeekSec()`、`#ensureIncomingStemPrep()`/`#takePreparedIncomingStems()` への `vocalStartSec` オプション追加、呼び出し2箇所——全て revert し、Phase 8 の元の実装（instrumental と vocal が同じ `startSec` で spawn される）に戻した。
- `src/player.acceptance.test.js`: 新規追加した回帰テスト（vocal と instrumental が異なる `startSec` で spawn されることを検証するテスト）を削除した。
- 検証: revert 後、`node --test src/player.acceptance.test.js`（72 pass / 1 skip、0 fail、Phase 9H merge直後の baseline と完全一致）を確認した。

### 未決事項 / 将来の実装に向けて

- **§11 を安全に実現するには、promotion時点でのタイムライン整合を保証する仕組みが不可欠**——vocal を独立timelineにする以上、`incoming.full`（あるいはpromotion機構そのもの）がその独立timelineを認識し、乖離を吸収する必要がある。候補は上記「micro-tempo catch-up」、または「promotion直前に短い二次クロスフェードを挟んでvocalのnative位置をincoming.fullへ滑らかに合流させる」等——いずれも Phase 8 の MixStream 中核ロジックへの本格的な設計変更を要する。
- **問題1（room check）・問題3（underflow時のalignment）は、上記アーキテクチャ変更とセットでなければ意味を持たない**——vocal のみを独立させても promotion で結局ズレる以上、単独で直す理由がない。
- **実運用での聴感評価は未実施**（そもそも実装を revert したため対象外）。

### 完了条件（§11/§17 9I 相当）

- [ ] incoming instrumental と vocal で seek 位置を分離する——実装したが、promotion時のタイムライン不整合（上記問題2）により revert
- [ ] vocal の音として聞こえる開始位置を `firstVocalStartSec` と一致させる——同上、根本対処には至らず
- [ ] promotion時のタイムライン整合を保証する仕組み（未決事項参照、將来のフェーズまたは大規模リファクタリングのスコープ）
- [ ] 実運用での聴感評価（上記未決事項参照）
