import { nowUnix, recordOperationLog } from './route-utils.js'
import { optimizeTrackOrder, isValidPermutation } from '../../../mix/ordering.js'
import { createGeneratedUserPlaylist } from '../services/playlistGenerateService.js'
import { searchYoutube as defaultSearchYoutube } from '../../../search.js'
import { resolveYoutubeTrack } from '../matching.js'
import {
  REFINE_TIMEOUT_MS,
  createRefineRateLimiter,
} from '../services/gemini.js'

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// Mirrors the operation_logs CHECK(source IN (...)) constraint. recordOperationLog
// only console.errors on an insert failure (never rethrows), so without this
// the route would return 200 while a bad source silently dropped the row.
const VALID_LOG_SOURCES = new Set(['command', 'control', 'admin'])

function getBearerToken(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, token] = header.split(' ')
  if (scheme !== 'Bearer' || !token) return null
  return token
}

function upsertDiscordUser(db, { discordId, username }) {
  const now = nowUnix()
  db.prepare(`
    INSERT INTO discord_users (discord_id, username, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at
  `).run(discordId, username ?? discordId, now, now)
}

// Bot process -> Web process channel for play history, mirroring the
// Web -> Bot direction (src/botApi.js). Guarded by the same BOT_API_TOKEN
// shared secret rather than the cookie-session requireAuth middleware, since
// the caller here is the bot process, not a browser.
export async function internalRoutes(app, {
  db,
  token,
  gemini = null,
  refineLimiter = createRefineRateLimiter(),
  searchYoutube = defaultSearchYoutube,
} = {}) {
  app.addHook('onRequest', async (request, reply) => {
    if (!token || getBearerToken(request) !== token) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.post('/internal/play-history', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { guildId, discordUserId, username, trackTitle, trackUrl, videoId, channel } = request.body ?? {}
    if (!guildId || !discordUserId || !trackTitle || !trackUrl) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    upsertDiscordUser(db, { discordId: discordUserId, username })
    db.prepare(`
      INSERT INTO play_history (guild_id, discord_user_id, video_id, channel, track_title, track_url, played_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, discordUserId, videoId ?? null, channel ?? null, trackTitle, trackUrl, nowUnix())
    return reply.send({ ok: true })
  })

  app.post('/internal/operation-log', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { guildId, discordUserId, username, source, action, detail, success } = request.body ?? {}
    if (!guildId || !source || !action) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    if (!VALID_LOG_SOURCES.has(source)) {
      return reply.code(400).send({ error: 'invalid_source' })
    }
    recordOperationLog(db, { guildId, discordUserId, username, source, action, detail, success: success !== false })
    return reply.send({ ok: true })
  })

  app.get('/internal/play-history/recent', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { guildId, userIds, limit } = request.query ?? {}
    if (!guildId || !userIds) {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    const ids = String(userIds).split(',').map((id) => id.trim()).filter(Boolean)
    const parsedLimit = Number.parseInt(limit, 10)
    const rowLimit = Math.min(Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 200, 500)
    const stmt = db.prepare(`
      SELECT video_id as videoId, channel, played_at as playedAt
      FROM play_history
      WHERE guild_id = ? AND discord_user_id = ?
      ORDER BY played_at DESC, id DESC
      LIMIT ?
    `)
    const result = {}
    for (const userId of ids) {
      result[userId] = stmt.all(guildId, userId, rowLimit)
    }
    return reply.send(result)
  })

  app.get('/internal/track-analysis/:videoId', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { videoId } = request.params ?? {}
    if (!videoId) return reply.code(400).send({ error: 'missing_fields' })
    const row = db.prepare(`
      SELECT payload_json AS payloadJson, version, analyzed_at AS analyzedAt
      FROM track_analysis WHERE video_id = ?
    `).get(videoId)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    return reply.send({
      version: row.version,
      analyzedAt: row.analyzedAt,
      analysis: JSON.parse(row.payloadJson),
    })
  })

  app.put('/internal/track-analysis/:videoId', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { videoId } = request.params ?? {}
    const analysis = request.body?.analysis
    if (!videoId || !analysis || typeof analysis !== 'object') {
      return reply.code(400).send({ error: 'missing_fields' })
    }
    const now = nowUnix()
    // analyzeTrackFile may send ms (legacy) or seconds; store Unix seconds only.
    const analyzedAtSec = Number.isFinite(analysis.analyzedAt)
      ? Math.floor(analysis.analyzedAt > 1e11 ? analysis.analyzedAt / 1000 : analysis.analyzedAt)
      : now
    db.prepare(`
      INSERT INTO track_analysis (
        video_id, version, duration_sec, tail_shape, last_rms, bpm, bpm_confidence,
        head_key, tail_key, harmonic_confidence, vocal_confidence,
        recommended_overlap_sec, confidence, payload_json, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        version = excluded.version,
        duration_sec = excluded.duration_sec,
        tail_shape = excluded.tail_shape,
        last_rms = excluded.last_rms,
        bpm = excluded.bpm,
        bpm_confidence = excluded.bpm_confidence,
        head_key = excluded.head_key,
        tail_key = excluded.tail_key,
        harmonic_confidence = excluded.harmonic_confidence,
        vocal_confidence = excluded.vocal_confidence,
        recommended_overlap_sec = excluded.recommended_overlap_sec,
        confidence = excluded.confidence,
        payload_json = excluded.payload_json,
        analyzed_at = excluded.analyzed_at
    `).run(
      videoId,
      analysis.version ?? 1,
      analysis.durationSec ?? null,
      analysis.tailShape ?? null,
      analysis.lastRms ?? null,
      analysis.bpm ?? null,
      analysis.bpmConfidence ?? null,
      analysis.headKey ?? null,
      analysis.tailKey ?? null,
      analysis.harmonicConfidence ?? null,
      analysis.vocalConfidence ?? null,
      analysis.recommendedOverlapSec ?? null,
      analysis.confidence ?? null,
      JSON.stringify(analysis),
      analyzedAtSec,
    )
    return reply.send({ ok: true })
  })

  function loadAnalysis(videoId) {
    if (!videoId || !db) return null
    const row = db.prepare(`
      SELECT payload_json AS payloadJson FROM track_analysis WHERE video_id = ?
    `).get(videoId)
    if (!row) return null
    try {
      return JSON.parse(row.payloadJson)
    } catch {
      return null
    }
  }

  app.post('/internal/optimize-order', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    const { guildId = null, anchorVideoId = null, tracks } = request.body ?? {}
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return reply.code(400).send({ error: 'missing_fields' })
    }

    const analyses = tracks.map((track) => {
      if (track?.analysis && typeof track.analysis === 'object') return track.analysis
      return loadAnalysis(track?.videoId)
    });
    const anchorAnalysis = anchorVideoId ? loadAnalysis(anchorVideoId) : null

    let order = optimizeTrackOrder({ anchorAnalysis, tracks, analyses })
    let source = 'algorithm'

    // Gemini refine is optional and must stay under the bot's ~5s webClient abort.
    // Rate-limit paid calls; on limit/timeout/failure keep the algorithm order.
    if (gemini && tracks.length >= 2) {
      const limitKey = guildId || 'global'
      if (refineLimiter.tryBegin(limitKey)) {
        try {
          const refined = await Promise.race([
            gemini.refineOrder({
              tracks,
              algorithmOrder: order,
              timeoutMs: REFINE_TIMEOUT_MS,
            }),
            delay(REFINE_TIMEOUT_MS).then(() => null),
          ])
          if (refined && isValidPermutation(refined, tracks.length)) {
            order = refined
            source = 'gemini'
          }
        } finally {
          refineLimiter.end(limitKey)
        }
      }
    }

    return reply.send({ order, source })
  })

  app.post('/internal/generate-playlist', async (request, reply) => {
    if (!db) throw new Error('db is required for internal routes')
    if (!gemini?.generateTrackList) {
      return reply.code(503).send({ error: 'gemini_unavailable' })
    }

    const {
      discordUserId,
      username,
      prompt,
      targetCount,
      name = null,
    } = request.body ?? {}

    if (!discordUserId || !username || !prompt) {
      return reply.code(400).send({ error: 'missing_fields' })
    }

    upsertDiscordUser(db, { discordId: discordUserId, username })

    const playlist = await createGeneratedUserPlaylist({
      db,
      gemini,
      userId: discordUserId,
      username,
      prompt,
      targetCount,
      name,
      searchYoutubeFn: searchYoutube,
      resolveYoutubeTrackFn: resolveYoutubeTrack,
      loadAnalysisFn: async (videoId) => loadAnalysis(videoId),
    })

    return reply.send({ playlist })
  })
}
