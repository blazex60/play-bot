import { decrypt, encrypt, getKeyId } from './crypto.js'
import { getDatabase } from './index.js'

const REFRESH_SKEW_MS = 60_000
const inflightRefreshes = new Map()

let fetchImpl = globalThis.fetch

function now() {
  return Date.now()
}

function refreshKey(userId, service) {
  return `${userId}:${service}`
}

function getRefreshConfig(service) {
  if (service === 'spotify') {
    return {
      url: 'https://accounts.spotify.com/api/token',
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      authStyle: 'basic',
    }
  }
  if (service === 'youtube') {
    return {
      url: 'https://oauth2.googleapis.com/token',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authStyle: 'body',
    }
  }
  throw new Error(`Unsupported service: ${service}`)
}

function readLink(db, userId, service) {
  return db.prepare(`
    SELECT *
    FROM service_links
    WHERE discord_user_id = ? AND service = ?
  `).get(userId, service)
}

function markNeedsRelink(db, id) {
  db.prepare(`
    UPDATE service_links
    SET status = 'needs_relink', updated_at = ?
    WHERE id = ?
  `).run(now(), id)
}

async function refreshAccessToken(db, link) {
  const refreshToken = decrypt(link.refresh_token_enc)
  if (!refreshToken) {
    markNeedsRelink(db, link.id)
    return null
  }

  const config = getRefreshConfig(link.service)
  if (!config.clientId || !config.clientSecret) {
    throw new Error(`Missing OAuth client config for ${link.service}`)
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (config.authStyle === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
  } else {
    body.set('client_id', config.clientId)
    body.set('client_secret', config.clientSecret)
  }

  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers,
    body,
  })

  if (!response.ok) {
    markNeedsRelink(db, link.id)
    return null
  }

  const payload = await response.json()
  if (!payload.access_token) {
    markNeedsRelink(db, link.id)
    return null
  }

  const updatedAt = now()
  const nextRefreshToken = payload.refresh_token ?? refreshToken
  const expiresIn = Number(payload.expires_in)
  const expiresAt = Number.isFinite(expiresIn)
    ? updatedAt + expiresIn * 1000
    : null

  const result = db.prepare(`
    UPDATE service_links
    SET access_token_enc = ?,
        refresh_token_enc = ?,
        key_id = ?,
        scope = COALESCE(?, scope),
        token_expires_at = ?,
        status = 'active',
        updated_at = ?
    WHERE id = ? AND updated_at = ?
  `).run(
    encrypt(payload.access_token),
    encrypt(nextRefreshToken),
    getKeyId(),
    payload.scope ?? null,
    expiresAt,
    updatedAt,
    link.id,
    link.updated_at
  )

  if (result.changes === 0) {
    const current = readLink(db, link.discord_user_id, link.service)
    return current?.status === 'active' ? decrypt(current.access_token_enc) : null
  }

  return payload.access_token
}

export async function getValidAccessToken(userId, service, { db = getDatabase() } = {}) {
  const link = readLink(db, userId, service)
  if (!link || link.status !== 'active') return null

  const accessToken = decrypt(link.access_token_enc)
  if (!accessToken) {
    markNeedsRelink(db, link.id)
    return null
  }

  if (!link.token_expires_at || link.token_expires_at > now() + REFRESH_SKEW_MS) {
    return accessToken
  }

  const key = refreshKey(userId, service)
  if (!inflightRefreshes.has(key)) {
    inflightRefreshes.set(
      key,
      refreshAccessToken(db, link).finally(() => {
        inflightRefreshes.delete(key)
      })
    )
  }
  return inflightRefreshes.get(key)
}

export function upsertServiceLink({
  db = getDatabase(),
  userId,
  service,
  accessToken,
  refreshToken = null,
  scope = null,
  tokenExpiresAt = null,
}) {
  const timestamp = now()
  db.prepare(`
    INSERT INTO service_links (
      discord_user_id,
      service,
      access_token_enc,
      refresh_token_enc,
      key_id,
      scope,
      token_expires_at,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(discord_user_id, service) DO UPDATE SET
      access_token_enc = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      key_id = excluded.key_id,
      scope = excluded.scope,
      token_expires_at = excluded.token_expires_at,
      status = 'active',
      updated_at = excluded.updated_at
  `).run(
    userId,
    service,
    encrypt(accessToken),
    refreshToken === null ? null : encrypt(refreshToken),
    getKeyId(),
    scope,
    tokenExpiresAt,
    timestamp,
    timestamp
  )
}

export function configureTokenStoreForTest({ fetch } = {}) {
  fetchImpl = fetch ?? globalThis.fetch
  inflightRefreshes.clear()
}
