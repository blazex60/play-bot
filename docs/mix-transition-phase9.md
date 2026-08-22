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
