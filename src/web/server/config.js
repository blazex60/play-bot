const DEFAULT_PUBLIC_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_BOT_API_PORT = '3001'
const DEFAULT_WEB_PORT = '3000'

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function buildUrl(baseUrl, path) {
  return new URL(path, `${stripTrailingSlash(baseUrl)}/`).toString()
}

function parseDuration(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function createWebConfig(env = process.env) {
  const publicBaseUrl = stripTrailingSlash(env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL)
  const botApiPort = env.BOT_API_PORT ?? DEFAULT_BOT_API_PORT
  const botApiUrl = stripTrailingSlash(
    env.BOT_API_URL ?? `http://127.0.0.1:${botApiPort}`
  )
  const sessionTtlSeconds = parseDuration(env.WEB_SESSION_TTL_SECONDS, 60 * 60 * 24 * 30)
  const oauthStateTtlSeconds = parseDuration(env.OAUTH_STATE_TTL_SECONDS, 10 * 60)

  return {
    env: env.NODE_ENV ?? 'development',
    host: env.WEB_HOST ?? '127.0.0.1',
    port: Number.parseInt(env.WEB_PORT ?? DEFAULT_WEB_PORT, 10),
    publicBaseUrl,
    trustProxy: ['127.0.0.1', '::1'],
    session: {
      cookieName: env.WEB_SESSION_COOKIE_NAME ?? 'musicbot_session',
      secret: env.WEB_SESSION_SECRET,
      ttlSeconds: sessionTtlSeconds,
      secure: publicBaseUrl.startsWith('https://'),
    },
    oauth: {
      stateTtlSeconds: oauthStateTtlSeconds,
      discord: {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        redirectUri: env.DISCORD_OAUTH_REDIRECT ?? buildUrl(publicBaseUrl, '/auth/discord/callback'),
        authorizeUrl: 'https://discord.com/oauth2/authorize',
        tokenUrl: 'https://discord.com/api/oauth2/token',
        userUrl: 'https://discord.com/api/users/@me',
        scope: 'identify',
      },
      spotify: {
        clientId: env.SPOTIFY_CLIENT_ID,
        clientSecret: env.SPOTIFY_CLIENT_SECRET,
        redirectUri: buildUrl(publicBaseUrl, '/auth/spotify/callback'),
        authorizeUrl: 'https://accounts.spotify.com/authorize',
        tokenUrl: 'https://accounts.spotify.com/api/token',
        scope: 'playlist-read-private playlist-read-collaborative',
      },
      youtube: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: buildUrl(publicBaseUrl, '/auth/youtube/callback'),
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
      },
    },
    botApi: {
      url: botApiUrl,
      token: env.BOT_API_TOKEN,
    },
  }
}

export const defaultConfig = createWebConfig()
