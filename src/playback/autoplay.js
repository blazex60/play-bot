import { getGuildSettings } from '../shared/settings.js'
import { resolveRelated } from '../media/search.js'
import { createTrack } from './queue.js'
import { fmtDuration } from '../shared/format.js'
import { getLogger } from '../logging/appLogger.js'
import { isBeatmixTempoCompatible } from '../audio/beatmixTransition.js'

const log = getLogger('autoplay')

export const HALF_LIFE_DAYS = 14
export const STABLE_MIN_WEIGHT = 3.0
export const TOP_K = 3
const SECONDS_PER_DAY = 86400
// Extra recently-played seeds planAutoTrack tries when the primary seed(s)
// yield no usable candidate. Each costs one yt-dlp call, so keep it small.
export const AUTOPLAY_FALLBACK_SEEDS = 2
// GuildPlayer gives the whole queue-exhaustion round 30s. planAutoTrack keeps
// its seed loop inside this smaller budget (leaving room for history fetch and
// enqueue), and caps each yt-dlp call so one slow lookup can't eat it all.
export const AUTOPLAY_PLAN_BUDGET_MS = 20_000
export const AUTOPLAY_RELATED_TIMEOUT_MS = 7_000
// Tempo preference: among the top few candidates (already ranked by the
// related list and channel affinity), take the first whose analyzed tempo is
// within beatmix's 6% of the outgoing track (same octave: the planner
// rejects half/double matches), so the transition can beat-sync.
// Only already-analyzed candidates can win; unknown tempos never displace
// the top pick, and nothing outside the top few is considered.
export const TEMPO_PREFERENCE_TOP_N = 5
export const TEMPO_LOOKUP_TIMEOUT_MS = 1_500
const AUTOPLAY_MIN_LOOKUP_MS = 1_000

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

async function chooseAutoTrack(candidates, { guildId, lastTrack, attempts, groupChannelWeights, webClient, timeoutMs }) {
  if (attempts.length > 1) {
    log.info({ event: 'playback.autoplay.fallback_seed_used', guildId, lastVideoId: lastTrack.videoId, attempts }, '別の曲を起点に自動再生候補を取得')
  }
  const ranked = rankByChannelAffinity(candidates, groupChannelWeights)
  const chosen = await preferTempoCompatible(ranked, { guildId, lastTrack, webClient, timeoutMs })
  return toAutoplayTrack(chosen)
}

/**
 * @returns the first of the top TEMPO_PREFERENCE_TOP_N candidates whose
 * analyzed head tempo can beat-sync with lastTrack's tail, else ranked[0].
 * Lookups go through the internal API's analysis cache and are bounded by
 * `timeoutMs`; any failure just keeps the original top pick.
 */
export async function preferTempoCompatible(ranked, { guildId = null, lastTrack, webClient, timeoutMs = TEMPO_LOOKUP_TIMEOUT_MS } = {}) {
  const [first] = ranked
  if (!webClient?.getTrackAnalysis || !lastTrack?.videoId || ranked.length < 2 || !(timeoutMs > 0)) return first
  const top = ranked.slice(0, TEMPO_PREFERENCE_TOP_N)
  const lookup = (id) => (id ? Promise.resolve(webClient.getTrackAnalysis(id)).catch(() => null) : Promise.resolve(null))
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
  const analyses = await Promise.race([
    Promise.all([lookup(lastTrack.videoId), ...top.map((c) => lookup(c.videoId))]),
    timeout,
  ])
  clearTimeout(timer)
  if (!analyses) return first
  const [last, ...cands] = analyses
  const outgoingBpm = last?.tailBpm ?? last?.bpm
  if (!(outgoingBpm > 0)) return first
  const tempoOf = (a) => a?.headBpm ?? a?.bpm
  const index = cands.findIndex((a) => tempoOf(a) > 0 && isBeatmixTempoCompatible(tempoOf(a), outgoingBpm))
  if (index <= 0) return first
  log.info({
    event: 'playback.autoplay.tempo_preferred',
    guildId,
    lastVideoId: lastTrack.videoId,
    outgoingBpm,
    chosenVideoId: top[index].videoId,
    chosenBpm: tempoOf(cands[index]),
    skippedVideoId: first.videoId,
    skippedBpm: tempoOf(cands[0]) ?? null,
    rank: index,
  }, 'テンポの近い曲を自動再生に選んだ')
  return top[index]
}

async function tryResolveRelated(resolveRelatedFn, videoId, limit, timeoutMs) {
  if (!videoId) return null
  try {
    const candidates = await resolveRelatedFn(videoId, { limit, timeoutMs })
    return candidates.length > 0 ? candidates : null
  } catch (err) {
    log.error({ event: 'playback.resolverelated_failed', err }, 'resolveRelated 失敗')
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

export function formatAutoAddNotification(track) {
  return `🔀 自動再生: **${track.title}** (${fmtDuration(track.duration)}) をキューに追加しました`
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

export async function planAutoTrack({ guildId, channel, lastTrack, webClient, now, resolveRelatedFn = resolveRelated, recentVideoIds = [], budgetMs = AUTOPLAY_PLAN_BUDGET_MS, nowMs = Date.now } = {}) {
  const deadline = nowMs() + budgetMs
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

  // Seeds tried in order: the personalized consensus pick, the just-finished
  // track, then up to AUTOPLAY_FALLBACK_SEEDS of the session's most recent
  // other plays. A single seed can legitimately yield nothing usable (no RD
  // mix for that video, or the mix holds only already-excluded videos); before
  // the fallback seeds existed, that ended autoplay — and the session — on
  // the spot.
  const seeds = []
  if (consensusVideoId && consensusVideoId !== lastTrack.videoId) seeds.push(consensusVideoId)
  seeds.push(lastTrack.videoId)
  const fallbackSeeds = [...recentVideoIds]
    .reverse()
    .filter((id, index, all) => id && !seeds.includes(id) && all.indexOf(id) === index)
    .slice(0, AUTOPLAY_FALLBACK_SEEDS)
  seeds.push(...fallbackSeeds)

  // Pass 1 (strict) excludes the session's recent plays; only if no seed
  // yields a fresh candidate does pass 2 (relaxed) allow recent plays again,
  // reusing the lists already fetched — so a fallback seed gets the chance to
  // produce something new before autoplay settles for a repeat.
  const attempts = []
  const fetched = []
  for (const seedVideoId of seeds) {
    const remaining = deadline - nowMs()
    if (remaining < AUTOPLAY_MIN_LOOKUP_MS) {
      attempts.push({ seedVideoId, skipped: 'budget_exhausted' })
      break
    }
    const candidates = await tryResolveRelated(resolveRelatedFn, seedVideoId, 20, Math.min(AUTOPLAY_RELATED_TIMEOUT_MS, remaining))
    if (!candidates) {
      attempts.push({ seedVideoId, fetched: 0, usable: 0 })
      continue
    }
    // RD mix playlists conventionally include the seed video itself among the
    // results, so whichever seed actually produced these candidates must be
    // excluded too, not just the just-finished track.
    const baseExclude = new Set([lastTrack.videoId, seedVideoId])
    const strictExclude = new Set([...baseExclude, ...recentVideoIds])
    const strict = candidates.filter((candidate) => !candidate.videoId || !strictExclude.has(candidate.videoId))
    attempts.push({ seedVideoId, fetched: candidates.length, usable: strict.length })
    if (strict.length > 0) return chooseAutoTrack(strict, { guildId, lastTrack, attempts, groupChannelWeights, webClient, timeoutMs: Math.min(TEMPO_LOOKUP_TIMEOUT_MS, deadline - nowMs()) })
    fetched.push({ candidates, baseExclude })
  }

  // Exhausting candidates against the last-100 history would stall or
  // disconnect autoplay, so fall back to excluding only the just-played track
  // and each list's own seed when the recent-history exclusion leaves nothing.
  for (const { candidates, baseExclude } of fetched) {
    const relaxed = candidates.filter((candidate) => !candidate.videoId || !baseExclude.has(candidate.videoId))
    if (relaxed.length > 0) return chooseAutoTrack(relaxed, { guildId, lastTrack, attempts, groupChannelWeights, webClient, timeoutMs: Math.min(TEMPO_LOOKUP_TIMEOUT_MS, deadline - nowMs()) })
  }

  log.warn({ event: 'playback.autoplay.no_candidates', guildId, lastVideoId: lastTrack.videoId, attempts }, '自動再生の候補が見つからない')
  return null
}

export async function planRecommendations({ guildId, channel, lastTrack, webClient, now, resolveRelatedFn = resolveRelated, recentVideoIds = [] } = {}) {
  const settings = getGuildSettings(guildId)
  if (settings.autoplayMode !== 'recommend') return []

  const humanIds = getHumanIds(channel)
  if (humanIds.length === 0) return []

  const history = settings.personalize === true
    ? await webClient.getRecentHistory({ guildId, userIds: humanIds })
    : {}

  const excludeVideoIds = new Set([lastTrack?.videoId].filter(Boolean))
  const plans = []

  // Users who share the same seed (e.g. everyone falling back to lastTrack
  // when nobody has stable history) would otherwise each spawn their own
  // yt-dlp lookup for an identical result; resolve each distinct seed once.
  const candidatesBySeed = new Map()
  async function getCandidatesForSeed(seedVideoId) {
    if (!candidatesBySeed.has(seedVideoId)) {
      candidatesBySeed.set(seedVideoId, await tryResolveRelated(resolveRelatedFn, seedVideoId, 12))
    }
    return candidatesBySeed.get(seedVideoId)
  }

  for (const userId of humanIds) {
    const vector = buildDecayedVector(history[userId] ?? [], { now })
    const isStable = totalWeight(vector.videoWeights) >= STABLE_MIN_WEIGHT
    const [topEntry] = isStable ? topEntries(vector.videoWeights, 1) : []
    const seedVideoId = topEntry ? topEntry[0] : lastTrack?.videoId
    if (!seedVideoId) continue

    const candidates = await getCandidatesForSeed(seedVideoId)
    if (!candidates) continue

    const baseExcludeForUser = new Set([...excludeVideoIds, seedVideoId])
    const strictExcludeForUser = new Set([...baseExcludeForUser, ...recentVideoIds])
    let filtered = candidates.filter((candidate) => !candidate.videoId || !strictExcludeForUser.has(candidate.videoId))
    if (filtered.length === 0) {
      // Same fallback as planAutoTrack: don't let the recent-history
      // exclusion starve a user's recommendations down to zero candidates.
      filtered = candidates.filter((candidate) => !candidate.videoId || !baseExcludeForUser.has(candidate.videoId))
    }
    if (filtered.length === 0) continue

    const ranked = rankByChannelAffinity(filtered, vector.channelWeights)
    plans.push({ userId, candidates: ranked.slice(0, 3).map(toAutoplayTrack) })
  }

  return plans
}
