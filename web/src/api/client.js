const JSON_HEADERS = { 'content-type': 'application/json' }

/**
 * @typedef {{ title?: string, webpageUrl?: string, duration?: number, requestedBy?: string, thumbnail?: string }} Track
 * @typedef {{ active?: boolean, current?: Track | null, upcoming?: Track[], queue?: Track[], playerStatus?: string, loopMode?: string, autoplayMode?: string, personalize?: boolean }} PlaybackState
 * @typedef {{ discordId?: string, username?: string }} User
 * @typedef {{ service: string, linked?: boolean, status?: string, tokenExpiresAt?: number | null, updatedAt?: number | null }} ServiceLink
 * @typedef {{ id: string, name: string, trackCount?: number, tracks?: { total?: number } }} Playlist
 * @typedef {{ jobId: number, status: string, matchedCount?: number, failedCount?: number }} ImportJob
 * @typedef {{ id: number, source_title: string, source_artist?: string, matched_title?: string, match_status: string, replacement?: unknown }} ImportTrack
 * @typedef {{ id: number, name: string, trackCount?: number, createdAt?: number, updatedAt?: number, tracks?: SavedPlaylistTrack[] }} SavedPlaylist
 * @typedef {{ id: number, position?: number, title: string, webpageUrl: string, duration?: number | null, thumbnail?: string | null, videoId?: string | null, channel?: string | null }} SavedPlaylistTrack
 * @typedef {{ discordId: string, username: string }} KnownUser
 * @typedef {{ commands: string[], defaults: Record<string, string>, overrides: Record<string, Record<string, string>>, knownUsers: KnownUser[] }} AdminPermissions
 * @typedef {Record<string, string>} AdminVisibility
 * @typedef {{ id: number, discordUserId?: string | null, username?: string | null, source: string, action: string, detail?: string | null, success: boolean, createdAt: number }} OperationLogEntry
 * @typedef {{ method?: string, body?: unknown }} RequestOptions
 */

export class ApiError extends Error {
  /** @type {number} */
  status

  /** @type {unknown} */
  body

  /** @param {string} message @param {{ status?: number, body?: unknown }} [options] */
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status ?? 0
    this.body = body ?? null
  }
}

/** @param {Response} response */
async function parseResponse(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse error'
    throw new ApiError('API returned invalid JSON', {
      status: response.status,
      body: { raw: text, parseError: message },
    })
  }
}

/** @param {string} path @param {RequestOptions} [options] */
export async function request(path, { method = 'GET', body } = {}) {
  /** @type {RequestInit} */
  const init = {
    method,
    credentials: 'include',
  }
  if (body !== undefined) {
    init.headers = JSON_HEADERS
    init.body = JSON.stringify(body)
  }
  const response = await fetch(path, init)
  const payload = await parseResponse(response)
  if (!response.ok) {
    const bodyObject = typeof payload === 'object' && payload !== null ? payload : {}
    const message = 'message' in bodyObject && typeof bodyObject.message === 'string'
      ? bodyObject.message
      : 'error' in bodyObject && typeof bodyObject.error === 'string'
        ? bodyObject.error
        : `API request failed: ${method} ${path}`
    throw new ApiError(message, {
      status: response.status,
      body: payload,
    })
  }
  return payload
}

/** @param {Record<string, string | number | null | undefined>} values */
function searchParams(values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  return params.toString()
}

export const api = {
  me: () => request('/api/me'),
  /** @param {string} guildId */
  state: (guildId) => request(`/api/state/${encodeURIComponent(guildId)}`),
  /** @param {{ guildId: string, userId?: string }} params */
  permission: ({ guildId, userId }) => request(`/api/permission?${searchParams({ guildId, userId })}`),
  links: () => request('/api/links'),
  /** @param {string} service */
  playlists: (service) => request(`/api/links/${encodeURIComponent(service)}/playlists`),
  /** @param {string} service */
  relink: (service) => request(`/api/links/${encodeURIComponent(service)}/relink`, { method: 'POST' }),
  /** @param {string} service */
  disconnect: (service) => request(`/api/links/${encodeURIComponent(service)}`, { method: 'DELETE' }),
  /** @param {string} guildId @param {string} action @param {unknown} [body] */
  control: (guildId, action, body = {}) =>
    request(`/api/guilds/${encodeURIComponent(guildId)}/control/${action}`, { method: 'POST', body }),
  /** @param {string} guildId @param {string} action @param {unknown} body */
  queue: (guildId, action, body) =>
    request(`/api/guilds/${encodeURIComponent(guildId)}/queue/${action}`, { method: 'POST', body }),
  /** @param {string} guildId @param {unknown} body */
  importPlaylist: (guildId, body) =>
    request(`/api/import/${encodeURIComponent(guildId)}`, { method: 'POST', body }),
  /** @param {number} jobId */
  importTracks: (jobId) => request(`/api/import/jobs/${encodeURIComponent(jobId)}/tracks`),
  /** @param {number} trackId @param {string} query */
  searchImportTrack: (trackId, query) =>
    request(`/api/import/tracks/${encodeURIComponent(trackId)}/search`, { method: 'POST', body: { query } }),
  /** @param {number} trackId @param {unknown} body */
  replaceImportTrack: (trackId, body) =>
    request(`/api/import/tracks/${encodeURIComponent(trackId)}/replace`, { method: 'POST', body }),
  mySavedPlaylists: () => request('/api/playlists/mine'),
  /** @param {string} name */
  createSavedPlaylist: (name) => request('/api/playlists/mine', { method: 'POST', body: { name } }),
  /** @param {number} id */
  savedPlaylist: (id) => request(`/api/playlists/mine/${encodeURIComponent(id)}`),
  /** @param {number} id @param {string} name */
  renameSavedPlaylist: (id, name) =>
    request(`/api/playlists/mine/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }),
  /** @param {number} id */
  deleteSavedPlaylist: (id) => request(`/api/playlists/mine/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** @param {number} id @param {string} query */
  searchSavedPlaylistTrack: (id, query) =>
    request(`/api/playlists/mine/${encodeURIComponent(id)}/search`, { method: 'POST', body: { query } }),
  /** @param {number} id @param {{ url?: string, track?: unknown }} body */
  addSavedPlaylistTrack: (id, body) =>
    request(`/api/playlists/mine/${encodeURIComponent(id)}/tracks`, { method: 'POST', body }),
  /** @param {number} id @param {number} trackId */
  removeSavedPlaylistTrack: (id, trackId) =>
    request(`/api/playlists/mine/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' }),
  /** @param {number} id @param {number} fromIndex @param {number} toIndex */
  moveSavedPlaylistTrack: (id, fromIndex, toIndex) =>
    request(`/api/playlists/mine/${encodeURIComponent(id)}/tracks/move`, { method: 'POST', body: { fromIndex, toIndex } }),
  /** @param {number} id @param {string} guildId */
  queueSavedPlaylist: (id, guildId) =>
    request(`/api/playlists/mine/${encodeURIComponent(id)}/queue`, { method: 'POST', body: { guildId } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  /** @param {string} guildId @returns {Promise<AdminPermissions>} */
  adminPermissions: (guildId) => request(`/api/admin/${encodeURIComponent(guildId)}/permissions`),
  /** @param {string} guildId @param {string} command @param {'allow'|'deny'} value */
  setDefaultCommandPermission: (guildId, command, value) =>
    request(`/api/admin/${encodeURIComponent(guildId)}/permissions/default`, { method: 'POST', body: { command, value } }),
  /** @param {string} guildId @param {string} userId @param {string} command @param {'allow'|'deny'|null} value */
  setUserCommandPermission: (guildId, userId, command, value) =>
    request(`/api/admin/${encodeURIComponent(guildId)}/permissions/user`, { method: 'POST', body: { userId, command, value } }),
  /** @param {string} guildId @returns {Promise<AdminVisibility>} */
  adminVisibility: (guildId) => request(`/api/admin/${encodeURIComponent(guildId)}/visibility`),
  /** @param {string} guildId @param {string} command @param {'public'|'personal'} value */
  setCommandVisibility: (guildId, command, value) =>
    request(`/api/admin/${encodeURIComponent(guildId)}/visibility`, { method: 'POST', body: { command, value } }),
  /** @param {string} guildId @param {{ limit?: number, before?: number }} [params] */
  adminLogs: (guildId, params = {}) =>
    request(`/api/admin/${encodeURIComponent(guildId)}/logs?${searchParams(params)}`),
}
