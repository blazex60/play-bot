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
