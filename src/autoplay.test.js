import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildDecayedVector,
  formatAutoAddNotification,
  planAutoTrack,
  planRecommendations,
  topEntries,
  totalWeight,
} from './autoplay.js'
import { configureSettingsPathForTest, loadSettings, setAutoplayMode, setPersonalize } from './settings.js'

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

test('formatAutoAddNotification: includes the title and formatted duration', () => {
  const message = formatAutoAddNotification({ title: 'Some Song', duration: 100 })
  assert.equal(message, '🔀 自動再生: **Some Song** (1:40) をキューに追加しました')
})
