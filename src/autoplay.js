import { getGuildSettings } from './settings.js'
import { resolveRelated } from './search.js'
import { createTrack } from './queue.js'

export const HALF_LIFE_DAYS = 14
export const STABLE_MIN_WEIGHT = 3.0
export const TOP_K = 3
const SECONDS_PER_DAY = 86400

// Recency-decayed per-user preference vectors, keyed by videoId and by
// channel/uploader. Older plays fade toward zero instead of counting the
// same as a play from five minutes ago.
export function buildDecayedVector(historyRows, { now = Date.now() / 1000, halfLifeDays = HALF_LIFE_DAYS } = {}) {
  const videoWeights = new Map()
  const channelWeights = new Map()
  for (const row of historyRows ?? []) {
    const ageDays = Math.max(0, (now - row.playedAt) / SECONDS_PER_DAY)
    const weight = 0.5 ** (ageDays / halfLifeDays)
    if (row.videoId) videoWeights.set(row.videoId, (videoWeights.get(row.videoId) ?? 0) + weight)
    if (row.channel) channelWeights.set(row.channel, (channelWeights.get(row.channel) ?? 0) + weight)
  }
  return { videoWeights, channelWeights }
}

export function totalWeight(vector) {
  let sum = 0
  for (const weight of vector.values()) sum += weight
  return sum
}

export function topEntries(vector, k) {
  return [...vector.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
}

function getHumanIds(channel) {
  if (!channel?.members) return []
  return [...channel.members.values()].filter((member) => !member.user.bot).map((member) => member.id)
}

async function tryResolveRelated(resolveRelatedFn, videoId, limit) {
  if (!videoId) return null
  try {
    const candidates = await resolveRelatedFn(videoId, { limit })
    return candidates.length > 0 ? candidates : null
  } catch (err) {
    console.error('[autoplay] resolveRelated failed:', err.message)
    return null
  }
}

function rankByChannelAffinity(candidates, channelWeights) {
  if (!channelWeights || channelWeights.size === 0) return candidates
  return [...candidates].sort((a, b) => {
    const scoreA = a.channel ? (channelWeights.get(a.channel) ?? 0) : 0
    const scoreB = b.channel ? (channelWeights.get(b.channel) ?? 0) : 0
    return scoreB - scoreA
  })
}

function toAutoplayTrack(candidate) {
  return createTrack({
    title: candidate.title,
    webpageUrl: candidate.webpageUrl,
    duration: candidate.duration,
    requestedBy: '🔀 自動再生',
    requestedById: null,
    thumbnail: candidate.thumbnail,
    videoId: candidate.videoId,
    channel: candidate.channel,
  })
}

// Finds the videoId that appears in the most stable users' own top-K
// preferences ("majority shared taste"). Returns null when fewer than two
// users have a stable signal, or when the best-shared item isn't backed by a
// majority of those stable users.
function findMajorityConsensusVideoId(stableVectors) {
  if (stableVectors.length < 2) return null

  const overlapCount = new Map()
  for (const vector of stableVectors) {
    const seen = new Set(topEntries(vector.videoWeights, TOP_K).map(([videoId]) => videoId))
    for (const videoId of seen) {
      overlapCount.set(videoId, (overlapCount.get(videoId) ?? 0) + 1)
    }
  }

  let bestVideoId = null
  let bestCount = 0
  for (const [videoId, count] of overlapCount) {
    if (count > bestCount) {
      bestCount = count
      bestVideoId = videoId
    }
  }
  return bestCount > stableVectors.length / 2 ? bestVideoId : null
}

export async function planAutoTrack({ guildId, channel, lastTrack, webClient, now, resolveRelatedFn = resolveRelated } = {}) {
  const settings = getGuildSettings(guildId)
  if (settings.autoplayMode !== 'auto') return null
  if (!lastTrack?.videoId) return null

  let consensusVideoId = null
  let groupChannelWeights = null

  if (settings.personalize === true) {
    const humanIds = getHumanIds(channel)
    if (humanIds.length > 0) {
      const history = await webClient.getRecentHistory({ guildId, userIds: humanIds })
      const vectors = humanIds.map((userId) => buildDecayedVector(history[userId] ?? [], { now }))

      groupChannelWeights = new Map()
      for (const vector of vectors) {
        for (const [ch, weight] of vector.channelWeights) {
          groupChannelWeights.set(ch, (groupChannelWeights.get(ch) ?? 0) + weight)
        }
      }

      const stableVectors = vectors.filter((vector) => totalWeight(vector.videoWeights) >= STABLE_MIN_WEIGHT)
      consensusVideoId = findMajorityConsensusVideoId(stableVectors)
    }
  }

  const excludeVideoIds = new Set([lastTrack.videoId])

  let candidates = consensusVideoId && consensusVideoId !== lastTrack.videoId
    ? await tryResolveRelated(resolveRelatedFn, consensusVideoId, 10)
    : null
  if (!candidates) {
    candidates = await tryResolveRelated(resolveRelatedFn, lastTrack.videoId, 10)
  }
  if (!candidates) return null

  const filtered = candidates.filter((candidate) => !candidate.videoId || !excludeVideoIds.has(candidate.videoId))
  if (filtered.length === 0) return null

  const [chosen] = rankByChannelAffinity(filtered, groupChannelWeights)
  return toAutoplayTrack(chosen)
}

export async function planRecommendations({ guildId, channel, lastTrack, webClient, now, resolveRelatedFn = resolveRelated } = {}) {
  const settings = getGuildSettings(guildId)
  if (settings.autoplayMode !== 'recommend') return []

  const humanIds = getHumanIds(channel)
  if (humanIds.length === 0) return []

  const history = settings.personalize === true
    ? await webClient.getRecentHistory({ guildId, userIds: humanIds })
    : {}

  const excludeVideoIds = new Set([lastTrack?.videoId].filter(Boolean))
  const plans = []

  for (const userId of humanIds) {
    const vector = buildDecayedVector(history[userId] ?? [], { now })
    const isStable = totalWeight(vector.videoWeights) >= STABLE_MIN_WEIGHT
    const [topEntry] = isStable ? topEntries(vector.videoWeights, 1) : []
    const seedVideoId = topEntry ? topEntry[0] : lastTrack?.videoId
    if (!seedVideoId) continue

    const candidates = await tryResolveRelated(resolveRelatedFn, seedVideoId, 6)
    if (!candidates) continue

    const filtered = candidates.filter((candidate) => !candidate.videoId || !excludeVideoIds.has(candidate.videoId))
    if (filtered.length === 0) continue

    const ranked = rankByChannelAffinity(filtered, vector.channelWeights)
    plans.push({ userId, candidates: ranked.slice(0, 3).map(toAutoplayTrack) })
  }

  return plans
}
