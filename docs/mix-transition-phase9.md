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
- **stem preference bonus (§6.4) を実際に検証する新規フィクスチャは追加していない**: beatmix と stem-mix が両方 eligible になり、bonus 差（+0.10 vs +0.05）がタイブレークとして効く、という具体的なシナリオへのユニットテストは今回追加していない（`rankTransitionCandidates()` の argmax ロジック自体は単純な比較なので正しさに高い自信はあるが、実際の分析値でどちらが勝つかは未検証）。理由: 既存の `stemFixtures()` は意図的に beatmix を ineligible にしており、beatmix 側を eligible にしつつ stem-mix 側も eligible にする現実的な数値のフィクスチャを新規に作る必要があるが、テスト全体の実行時間（`player.acceptance.test.js` 1本で約40秒）を踏まえてこのセッションでは見送った。次フェーズ以降で `transitionCandidates.js` の単体テストとして追加することを推奨する。
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
