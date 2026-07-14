export class BotApiError extends Error {
  constructor(message, { status, body }) {
    super(message)
    this.name = 'BotApiError'
    this.status = status
    this.body = body
  }
}

export function createBotClient({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  if (!baseUrl) {
    throw new Error('BOT_API_URL is required')
  }
  if (!token) {
    throw new Error('BOT_API_TOKEN is required')
  }

  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetchImpl(new URL(path, `${baseUrl}/`), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new BotApiError(`Bot API request failed: ${method} ${path}`, {
        status: response.status,
        body: payload,
      })
    }
    return payload
  }

  return {
    // Generic passthrough required by route-utils.js#callBot (used by
    // control/queue routes and the requireBotPermission fallback), which
    // expect botClient.request(method, path, body) to exist.
    request: (method, path, body) => request(path, { method, body }),
    healthz: () => request('/healthz'),
    state: (guildId) => request(`/state/${encodeURIComponent(guildId)}`),
    permission: ({ guildId, userId }) => {
      const search = new URLSearchParams({ guildId, userId })
      return request(`/permission?${search.toString()}`)
    },
    control: (guildId, action, body) =>
      request(`/control/${encodeURIComponent(guildId)}/${action}`, { method: 'POST', body }),
    queue: (guildId, action, body) =>
      request(`/queue/${encodeURIComponent(guildId)}/${action}`, { method: 'POST', body }),
    enqueueImport: (guildId, body) =>
      request(`/import/${encodeURIComponent(guildId)}/enqueue`, { method: 'POST', body }),
  }
}
