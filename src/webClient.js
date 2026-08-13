import { randomUUID } from 'node:crypto'

export class WebApiError extends Error {
  constructor(message, { status, body }) {
    super(message)
    this.name = 'WebApiError'
    this.status = status
    this.body = body
  }
}

const DEFAULT_WEB_PORT = '3000'
const DEFAULT_REQUEST_TIMEOUT_MS = 5000
// Gemini (up to 2 × 15s) plus sequential yt-dlp searches; keep under Discord's deferred-token window.
export const GENERATE_REQUEST_TIMEOUT_MS = 120_000

function isAmbiguousGenerateFailure(err) {
  if (err?.name === 'AbortError') return true
  const status = err?.status
  if (status == null) return true
  if (status === 503 && err?.body?.error === 'gemini_unavailable') return false
  return status >= 500
}

// Bot -> Web internal channel, mirroring src/web/server/botClient.js's
// Web -> Bot direction. Every exported method fails soft (never throws) so a
// down/unreachable Web process can never block playback: recordPlay silently
// drops the event, getRecentHistory returns {} so autoplay falls back to the
// non-personalized queue-based path.
export function createWebClient({
  baseUrl = `http://127.0.0.1:${process.env.WEB_PORT ?? DEFAULT_WEB_PORT}`,
  token = process.env.BOT_API_TOKEN,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  generateTimeoutMs = GENERATE_REQUEST_TIMEOUT_MS,
} = {}) {
  async function request(path, { method = 'GET', body, timeoutMs = requestTimeoutMs } = {}) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
    // The timer must stay armed through response.text() too: fetchImpl can
    // resolve as soon as headers arrive, leaving the body stream itself free
    // to stall with no bound if the timer were cleared here already.
    try {
      const response = await fetchImpl(new URL(path, `${baseUrl}/`), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await response.text()
      const payload = text ? JSON.parse(text) : null
      if (!response.ok) {
        throw new WebApiError(`Web API request failed: ${method} ${path}`, {
          status: response.status,
          body: payload,
        })
      }
      return payload
    } finally {
      clearTimeout(timeoutHandle)
    }
  }

  return {
    async recordPlay({ guildId, discordUserId, username, trackTitle, trackUrl, videoId, channel }) {
      try {
        await request('/internal/play-history', {
          method: 'POST',
          body: { guildId, discordUserId, username, trackTitle, trackUrl, videoId, channel },
        })
      } catch (err) {
        console.error('[webClient] recordPlay failed:', err.message)
      }
    },
    async getRecentHistory({ guildId, userIds, limit } = {}) {
      try {
        if (!guildId || !Array.isArray(userIds) || userIds.length === 0) return {}
        const search = new URLSearchParams({ guildId, userIds: userIds.join(',') })
        if (limit) search.set('limit', String(limit))
        return (await request(`/internal/play-history/recent?${search.toString()}`)) ?? {}
      } catch (err) {
        console.error('[webClient] getRecentHistory failed:', err.message)
        return {}
      }
    },
    async logOperation({ guildId, discordUserId, username, source, action, detail, success }) {
      try {
        await request('/internal/operation-log', {
          method: 'POST',
          body: { guildId, discordUserId, username, source, action, detail, success },
        })
      } catch (err) {
        console.error('[webClient] logOperation failed:', err.message)
      }
    },
    async getTrackAnalysis(videoId) {
      try {
        if (!videoId) return null
        const payload = await request(`/internal/track-analysis/${encodeURIComponent(videoId)}`)
        return payload?.analysis ?? null
      } catch (err) {
        if (err?.status === 404) return null
        console.error('[webClient] getTrackAnalysis failed:', err.message)
        return null
      }
    },
    async putTrackAnalysis(videoId, analysis) {
      try {
        if (!videoId || !analysis) return false
        await request(`/internal/track-analysis/${encodeURIComponent(videoId)}`, {
          method: 'PUT',
          body: { analysis },
        })
        return true
      } catch (err) {
        console.error('[webClient] putTrackAnalysis failed:', err.message)
        return false
      }
    },
    async optimizeOrder({ guildId = null, anchorVideoId = null, tracks } = {}) {
      try {
        if (!Array.isArray(tracks) || tracks.length === 0) return null
        const payload = await request('/internal/optimize-order', {
          method: 'POST',
          body: { guildId, anchorVideoId, tracks },
        })
        if (!payload?.order || !Array.isArray(payload.order)) return null
        return payload
      } catch (err) {
        console.error('[webClient] optimizeOrder failed:', err.message)
        return null
      }
    },
    async generatePlaylist({
      discordUserId,
      username,
      prompt,
      targetCount = 10,
      name = null,
    } = {}) {
      try {
        if (!discordUserId || !username || !prompt) return null
        const payload = await request('/internal/generate-playlist', {
          method: 'POST',
          timeoutMs: generateTimeoutMs,
          body: {
            discordUserId,
            username,
            prompt,
            targetCount,
            name,
            idempotencyKey: randomUUID(),
          },
        })
        return payload?.playlist ?? null
      } catch (err) {
        console.error('[webClient] generatePlaylist failed:', err.message)
        if (isAmbiguousGenerateFailure(err)) return { ambiguous: true }
        return null
      }
    },
  }
}
