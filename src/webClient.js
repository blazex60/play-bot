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
} = {}) {
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs)
    let response
    try {
      response = await fetchImpl(new URL(path, `${baseUrl}/`), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutHandle)
    }
    const text = await response.text()
    const payload = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new WebApiError(`Web API request failed: ${method} ${path}`, {
        status: response.status,
        body: payload,
      })
    }
    return payload
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
  }
}
