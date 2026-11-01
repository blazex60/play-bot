import pino from 'pino'

const SENSITIVE_QUERY = /^(token|access_token|refresh_token|id_token|code|state|key|api[-_]?key|secret|password|signature|sig|auth|authorization|session|sid|cookie|client_secret|expire|expires|policy|x-amz-.*|x-goog-.*)$/i
const SENSITIVE_KEYS = [
  'token', 'accessToken', 'refreshToken', 'idToken', 'password', 'secret',
  'clientSecret', 'authorization', 'cookie', 'setCookie', 'apiKey',
]

/** pino `redact` paths: top-level, one nested level, and HTTP header slots. */
export const REDACT_PATHS = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map(key => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["x-api-key"]',
]

/** Strip sensitive query parameters and credentials from a URL-ish string. */
export function sanitizeUrl(input) {
  if (typeof input !== 'string' || input === '') return input
  const queryStart = input.indexOf('?')
  const hashStart = input.indexOf('#')
  const end = hashStart === -1 ? input.length : hashStart
  if (queryStart === -1 || queryStart > end) return hashStart === -1 ? input : input.slice(0, hashStart)
  const base = input.slice(0, queryStart)
  const query = input.slice(queryStart + 1, end)
  const kept = query.split('&').filter(Boolean).map(pair => {
    const [name] = pair.split('=')
    let decoded = name
    try { decoded = decodeURIComponent(name) } catch { /* keep raw */ }
    return SENSITIVE_QUERY.test(decoded) ? `${name}=[REDACTED]` : pair
  })
  return kept.length ? `${base}?${kept.join('&')}` : base
}

const SECRET_PATTERNS = [
  [/\b(Bearer|Bot|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // Discord bot token: three base64url segments
  [/\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, '[REDACTED_DISCORD_TOKEN]'],
  [/([?&](?:token|access_token|refresh_token|client_secret|signature|sig|key)=)[^&\s"']+/gi, '$1[REDACTED]'],
]

/** Best-effort scrub of secrets embedded in free-form strings (error messages). */
export function scrubString(value) {
  if (typeof value !== 'string') return value
  let out = value
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Error serializer: standard shape, with secrets scrubbed from text fields. */
export function serializeError(err) {
  const base = pino.stdSerializers.err(err)
  if (!base || typeof base !== 'object') return base
  if (base.message) base.message = scrubString(base.message)
  if (base.stack) base.stack = scrubString(base.stack)
  return base
}

/** Request serializer: method, sanitized route, no headers/body. */
export function serializeRequest(req) {
  return {
    method: req?.method,
    url: sanitizeUrl(req?.originalUrl ?? req?.url),
    id: req?.id,
  }
}

export function serializeResponse(res) {
  return { statusCode: res?.statusCode }
}
