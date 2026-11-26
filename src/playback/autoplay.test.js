import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AUTOPLAY_FALLBACK_SEEDS,
  AUTOPLAY_RELATED_TIMEOUT_MS,
  buildDecayedVector,
  formatAutoAddNotification,
  planAutoTrack,
  planRecommendations,
  preferTempoCompatible,
  TEMPO_PREFERENCE_TOP_N,
  topEntries,
  totalWeight,
} from './autoplay.js'
import { configureSettingsPathForTest, loadSettings, setAutoplayMode, setPersonalize } from '../shared/settings.js'

async function withTempSettings(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'music-bot-autoplay-test-'))
  configureSettingsPathForTest(join(dir, 'data', 'guild-settings.json'))
  loadSettings()
  try {
    await fn()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function makeHuman(id) {
  return { id, user: { bot: false } }
}

function makeChannel(memberIds) {
  return { members: new Map(memberIds.map((id) => [id, makeHuman(id)])) }
}

function makeCandidate(videoId, { title = videoId, channel = null } = {}) {
  return { title, webpageUrl: `https://example.com/${videoId}`, duration: 100, thumbnail: null, videoId, channel }
}

function makeWebClient(historyByUser) {
  return {
    async getRecentHistory({ userIds }) {
      const result = {}
      for (const id of userIds) result[id] = historyByUser[id] ?? []
      return result
    },
  }
}

const NOW = 1_700_000_000 // fixed unix seconds

test('buildDecayedVector: recent plays weigh more than old ones', () => {
  const { videoWeights } = buildDecayedVector(
    [
      { videoId: 'old', playedAt: NOW - 30 * 86400 },
      { videoId: 'new', playedAt: NOW },
    ],
    { now: NOW, halfLifeDays: 14 }
  )
  assert.ok(videoWeights.get('new') > videoWeights.get('old'))
})

test('totalWeight/topEntries: sums and ranks a vector', () => {
  const { videoWeights } = buildDecayedVector(
    [
      { videoId: 'a', playedAt: NOW },
      { videoId: 'a', playedAt: NOW },
      { videoId: 'b', playedAt: NOW },
    ],
    { now: NOW }
  )
  assert.ok(totalWeight(videoWeights) > 2)
  assert.deepEqual(topEntries(videoWeights, 1)[0][0], 'a')
})

test('planAutoTrack: mode off returns null without calling resolveRelated', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'off')
    const resolveRelatedFn = async () => { throw new Error('should not be called') }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
    })
    assert.equal(result, null)
  })
})

test('planAutoTrack: personalize off falls back to the last played track as seed', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      return [makeCandidate('related-1')]
    }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
    })
    assert.deepEqual(calls, ['last'])
    assert.equal(result.videoId, 'related-1')
  })
})

test('planAutoTrack: fewer than 2 stable users falls back to queue seed', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', true)
    const history = { u1: [{ videoId: 'fav', channel: 'C', playedAt: NOW }] } // below STABLE_MIN_WEIGHT
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      return [makeCandidate('related-1')]
    }
    await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient(history),
      resolveRelatedFn,
      now: NOW,
    })
    assert.deepEqual(calls, ['last'])
  })
})

test('planAutoTrack: majority-shared videoId across stable users is used as the seed', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', true)
    const heavyHistory = (videoId) =>
      Array.from({ length: 6 }, () => ({ videoId, channel: null, playedAt: NOW }))
    const history = {
      u1: heavyHistory('shared'),
      u2: heavyHistory('shared'),
      u3: heavyHistory('unique-3'),
    }
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      return [makeCandidate('related-1')]
    }
    await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1', 'u2', 'u3']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient(history),
      resolveRelatedFn,
      now: NOW,
    })
    assert.deepEqual(calls, ['shared'], 'the videoId shared by a majority of stable users should be tried first')
  })
})

test('planAutoTrack: no majority overlap falls back to queue seed even with personalize on', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', true)
    const heavyHistory = (videoId) =>
      Array.from({ length: 6 }, () => ({ videoId, channel: null, playedAt: NOW }))
    const history = { u1: heavyHistory('a'), u2: heavyHistory('b') } // no overlap at all
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      return [makeCandidate('related-1')]
    }
    await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1', 'u2']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient(history),
      resolveRelatedFn,
      now: NOW,
    })
    assert.deepEqual(calls, ['last'])
  })
})

test('planAutoTrack: candidates are re-ranked by group channel affinity', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', true)
    const history = {
      u1: [{ videoId: 'x', channel: 'Loved Channel', playedAt: NOW }, { videoId: 'y', channel: 'Loved Channel', playedAt: NOW }],
    }
    const resolveRelatedFn = async () => [
      makeCandidate('unrelated', { channel: 'Other Channel' }),
      makeCandidate('preferred', { channel: 'Loved Channel' }),
    ]
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient(history),
      resolveRelatedFn,
      now: NOW,
    })
    assert.equal(result.videoId, 'preferred')
  })
})

test('planAutoTrack: resolveRelated failure returns null', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const resolveRelatedFn = async () => { throw new Error('yt-dlp exploded') }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
    })
    assert.equal(result, null)
  })
})

test('planAutoTrack: candidates in recentVideoIds are excluded', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const resolveRelatedFn = async () => [makeCandidate('recent-1'), makeCandidate('fresh-1')]
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['recent-1'],
    })
    assert.equal(result.videoId, 'fresh-1')
  })
})

test('planAutoTrack: falls back to picking from recent history when exclusion leaves no candidates', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const resolveRelatedFn = async () => [makeCandidate('recent-1'), makeCandidate('recent-2')]
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['recent-1', 'recent-2'],
    })
    assert.ok(result, 'should fall back to a candidate instead of returning null')
    assert.ok(['recent-1', 'recent-2'].includes(result.videoId))
  })
})

test('planAutoTrack: when the last track yields no usable candidate, falls back to the newest other recent play as seed', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      // The RD mix of 'last' holds only itself (no real mix available).
      if (videoId === 'last') return [makeCandidate('last')]
      return [makeCandidate(videoId), makeCandidate(`rel-of-${videoId}`)]
    }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      // oldest -> newest, as session.recentPlayedVideoIds is recorded
      recentVideoIds: ['older', 'newer', 'last'],
    })
    assert.deepEqual(calls, ['last', 'newer'])
    assert.equal(result.videoId, 'rel-of-newer')
  })
})

test('planAutoTrack: an empty or failing related lookup also moves on to a fallback seed', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      if (videoId === 'last') return []
      if (videoId === 'newer') throw new Error('yt-dlp exited 1')
      return [makeCandidate('rel-of-older')]
    }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['older', 'newer', 'last'],
    })
    assert.deepEqual(calls, ['last', 'newer', 'older'])
    assert.equal(result.videoId, 'rel-of-older')
  })
})

test('planAutoTrack: fallback seeds are bounded and the result is null when none yields a candidate', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const calls = []
    const resolveRelatedFn = async (videoId) => {
      calls.push(videoId)
      return []
    }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['r1', 'r2', 'r3', 'r4', 'r2', 'last'],
    })
    assert.equal(result, null)
    assert.equal(calls.length, 1 + AUTOPLAY_FALLBACK_SEEDS)
    assert.deepEqual(calls, ['last', 'r2', 'r4'].slice(0, 1 + AUTOPLAY_FALLBACK_SEEDS))
  })
})

test('planAutoTrack: a fresh candidate from a fallback seed beats repeating a recent play', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const resolveRelatedFn = async (videoId) => {
      if (videoId === 'last') return [makeCandidate('newer'), makeCandidate('older')] // all recently played
      return [makeCandidate('fresh-from-newer')]
    }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['older', 'newer', 'last'],
    })
    assert.equal(result.videoId, 'fresh-from-newer')
  })
})

test('planAutoTrack: each related lookup gets a bounded timeout and the seed loop stops at the budget', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    let clock = 0
    const calls = []
    const resolveRelatedFn = async (videoId, { timeoutMs }) => {
      calls.push({ videoId, timeoutMs })
      clock += 6_000 // each lookup is slow
      return []
    }
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['r1', 'r2', 'last'],
      budgetMs: 10_000,
      nowMs: () => clock,
    })
    assert.equal(result, null)
    assert.deepEqual(calls, [
      { videoId: 'last', timeoutMs: AUTOPLAY_RELATED_TIMEOUT_MS },
      { videoId: 'r2', timeoutMs: 4_000 },
    ], 'second lookup is capped by the remaining budget, third is skipped')
  })
})

test('planAutoTrack: no lastTrack.videoId returns null', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: null },
      webClient: makeWebClient({}),
      resolveRelatedFn: async () => [makeCandidate('x')],
      now: NOW,
    })
    assert.equal(result, null)
  })
})

test('planRecommendations: mode not recommend returns empty list', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    const plans = await planRecommendations({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn: async () => [makeCandidate('x')],
      now: NOW,
    })
    assert.deepEqual(plans, [])
  })
})

test('planRecommendations: builds one plan per human VC member, seeded by their own top track when stable', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'recommend')
    await setPersonalize('g1', true)
    const heavyHistory = (videoId) =>
      Array.from({ length: 6 }, () => ({ videoId, channel: null, playedAt: NOW }))
    const history = { u1: heavyHistory('u1-fav'), u2: [] }
    const seedsUsed = []
    const resolveRelatedFn = async (videoId) => {
      seedsUsed.push(videoId)
      return [makeCandidate(`${videoId}-related`)]
    }
    const plans = await planRecommendations({
      guildId: 'g1',
      channel: makeChannel(['u1', 'u2']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient(history),
      resolveRelatedFn,
      now: NOW,
    })
    assert.equal(plans.length, 2)
    assert.ok(seedsUsed.includes('u1-fav'), 'stable user should be seeded from their own top track')
    assert.ok(seedsUsed.includes('last'), 'user without stable history should fall back to the queue seed')
  })
})

test('planRecommendations: skips users with no resolvable candidates', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'recommend')
    const resolveRelatedFn = async () => { throw new Error('boom') }
    const plans = await planRecommendations({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
    })
    assert.deepEqual(plans, [])
  })
})

test('planRecommendations: candidates in recentVideoIds are excluded', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'recommend')
    await setPersonalize('g1', false)
    const resolveRelatedFn = async () => [makeCandidate('recent-1'), makeCandidate('fresh-1')]
    const plans = await planRecommendations({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['recent-1'],
    })
    assert.equal(plans.length, 1)
    assert.deepEqual(plans[0].candidates.map((c) => c.videoId), ['fresh-1'])
  })
})

test('planRecommendations: falls back to picking from recent history when exclusion leaves no candidates', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'recommend')
    await setPersonalize('g1', false)
    const resolveRelatedFn = async () => [makeCandidate('recent-1'), makeCandidate('recent-2')]
    const plans = await planRecommendations({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: makeWebClient({}),
      resolveRelatedFn,
      now: NOW,
      recentVideoIds: ['recent-1', 'recent-2'],
    })
    assert.equal(plans.length, 1, 'should fall back instead of skipping the user entirely')
    assert.ok(['recent-1', 'recent-2'].includes(plans[0].candidates[0].videoId))
  })
})

test('formatAutoAddNotification: includes the title and formatted duration', () => {
  const message = formatAutoAddNotification({ title: 'Some Song', duration: 100 })
  assert.equal(message, '🔀 自動再生: **Some Song** (1:40) をキューに追加しました')
})

// --- tempo preference (beatmix needs tempos within 6%) ---------------------

function analysisClient(bpmById, { delayMs = 0 } = {}) {
  return {
    ...makeWebClient({}),
    async getTrackAnalysis(videoId) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      const bpm = bpmById[videoId]
      return bpm == null ? null : { bpm, headBpm: bpm, tailBpm: bpm }
    },
  }
}

test('preferTempoCompatible picks the first top candidate within beatmix tempo range', async () => {
  const ranked = ['a', 'b', 'c', 'd'].map((id) => makeCandidate(id))
  // last = 120; a is 150 (too far), b unknown, c = 122 (1.7%), d = 120
  const chosen = await preferTempoCompatible(ranked, { lastTrack: { videoId: 'last' }, webClient: analysisClient({ last: 120, a: 150, c: 122, d: 120 }) })
  assert.equal(chosen.videoId, 'c')
})

test('preferTempoCompatible treats half/double tempo as compatible', async () => {
  const ranked = ['a', 'b'].map((id) => makeCandidate(id))
  const chosen = await preferTempoCompatible(ranked, { lastTrack: { videoId: 'last' }, webClient: analysisClient({ last: 196, a: 140, b: 99 }) })
  assert.equal(chosen.videoId, 'b')
})

test('preferTempoCompatible keeps the top pick when nothing is known, nothing matches, or lookups are slow', async () => {
  const ranked = ['a', 'b', 'c'].map((id) => makeCandidate(id))
  const last = { videoId: 'last' }
  assert.equal((await preferTempoCompatible(ranked, { lastTrack: last, webClient: analysisClient({ last: 120 }) })).videoId, 'a')
  assert.equal((await preferTempoCompatible(ranked, { lastTrack: last, webClient: analysisClient({ a: 120, b: 120 }) })).videoId, 'a', 'outgoing tempo unknown')
  assert.equal((await preferTempoCompatible(ranked, { lastTrack: last, webClient: analysisClient({ last: 120, a: 150, b: 90, c: 170 }) })).videoId, 'a')
  assert.equal((await preferTempoCompatible(ranked, { lastTrack: last, webClient: analysisClient({ last: 120, b: 120 }, { delayMs: 50 }), timeoutMs: 10 })).videoId, 'a')
  assert.equal((await preferTempoCompatible(ranked, { lastTrack: last, webClient: makeWebClient({}) })).videoId, 'a', 'no getTrackAnalysis')
})

test('preferTempoCompatible never looks past the top candidates', async () => {
  const ranked = Array.from({ length: TEMPO_PREFERENCE_TOP_N + 2 }, (_, i) => makeCandidate(`c${i}`))
  const bpm = { last: 120 }
  ranked.forEach((c, i) => { bpm[c.videoId] = i < TEMPO_PREFERENCE_TOP_N ? 150 : 120 })
  const chosen = await preferTempoCompatible(ranked, { lastTrack: { videoId: 'last' }, webClient: analysisClient(bpm) })
  assert.equal(chosen.videoId, 'c0')
})

test('planAutoTrack applies the tempo preference to the related candidates', async () => {
  await withTempSettings(async () => {
    await setAutoplayMode('g1', 'auto')
    await setPersonalize('g1', false)
    const result = await planAutoTrack({
      guildId: 'g1',
      channel: makeChannel(['u1']),
      lastTrack: { videoId: 'last' },
      webClient: analysisClient({ last: 128, 'related-1': 175, 'related-2': 130 }),
      resolveRelatedFn: async () => [makeCandidate('related-1'), makeCandidate('related-2')],
      now: NOW,
    })
    assert.equal(result.videoId, 'related-2')
  })
})
