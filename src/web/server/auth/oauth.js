import { createHash, randomBytes } from 'node:crypto'

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

export function createCodeVerifier() {
  return randomToken(32)
}

export function createCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function nowMs() {
  return Date.now()
}

export function insertOauthState({
  db,
  service,
  discordUserId = null,
  redirectAfter = '/',
  codeVerifier = null,
  ttlSeconds,
  now = nowMs(),
}) {
  const state = randomToken()
  db.prepare(`
    INSERT INTO oauth_states (
      state, discord_user_id, service, code_verifier, redirect_after, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    state,
    discordUserId,
    service,
    codeVerifier,
    redirectAfter,
    now,
    now + ttlSeconds * 1000
  )
  return state
}

export function consumeOauthState({ db, service, state, now = nowMs() }) {
  const row = db.prepare(`
    SELECT state, discord_user_id, service, code_verifier, redirect_after, expires_at
    FROM oauth_states
    WHERE state = ? AND service = ?
  `).get(state, service)
  if (!row) {
    return { ok: false, error: 'invalid_oauth_state' }
  }
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state)
  if (row.expires_at < now) {
    return { ok: false, error: 'expired_oauth_state' }
  }
  return { ok: true, row }
}

export async function fetchJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options)
  const text = await response.text()
  const body = text ? JSON.parse(text) : {}
  if (!response.ok) {
    const error = new Error(`OAuth provider request failed: ${response.status}`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

export function basicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
}

export function appendParams(baseUrl, params) {
  const url = new URL(baseUrl)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

export function tokenExpiresAt(tokenResponse, now = nowMs()) {
  if (!tokenResponse.expires_in) {
    return null
  }
  return now + Number(tokenResponse.expires_in) * 1000
}
