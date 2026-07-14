import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { createBotClient } from './botClient.js'
import { startCleanupJob } from './cleanup.js'
import { createWebConfig, defaultConfig } from './config.js'
import { registerDiscordAuthRoutes } from './auth/discord.js'
import { registerSpotifyAuthRoutes } from './auth/spotify.js'
import { registerYoutubeAuthRoutes } from './auth/youtube.js'
import { createRequireAuth } from './middleware/requireAuth.js'
import { runMigrations } from '../../db/migrate.js'
import { stateRoutes } from './routes/state.js'
import { linksRoutes } from './routes/links.js'
import { controlRoutes } from './routes/control.js'
import { queueRoutes } from './routes/queue.js'
import { importRoutes } from './routes/import.js'
import { importEditRoutes } from './routes/import-edit.js'

const thisDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(thisDir, '../../..')
const webDist = join(projectRoot, 'web/dist')

async function loadDefaultDb() {
  const dbModule = await import('../../db/index.js')
  if (typeof dbModule.getDatabase === 'function') {
    return dbModule.getDatabase()
  }
  if (typeof dbModule.getDb === 'function') {
    return dbModule.getDb()
  }
  if (typeof dbModule.openDatabase === 'function') {
    return dbModule.openDatabase()
  }
  if (dbModule.db) {
    return dbModule.db
  }
  throw new Error('src/db/index.js must export getDb(), openDatabase(), or db')
}

export async function buildWebServer({
  config = defaultConfig,
  db,
  fetchImpl = globalThis.fetch,
  logger = true,
  startCleanup = true,
} = {}) {
  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
  })
  const database = db ?? await loadDefaultDb()
  runMigrations(database)

  await app.register(cookie, {
    secret: config.session.secret,
    hook: 'onRequest',
  })

  const requireAuth = createRequireAuth({ db: database, config })
  const botClient = createBotClient({
    baseUrl: config.botApi.url,
    token: config.botApi.token,
    fetchImpl,
  })

  app.decorate('db', database)
  app.decorate('botClient', botClient)
  app.decorate('requireAuth', requireAuth)

  app.get('/healthz', async () => ({
    ok: true,
    service: 'music-web',
    publicBaseUrl: config.publicBaseUrl,
    redirects: {
      discord: config.oauth.discord.redirectUri,
      spotify: config.oauth.spotify.redirectUri,
      youtube: config.oauth.youtube.redirectUri,
    },
  }))

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user,
  }))

  registerDiscordAuthRoutes(app, { db: database, config, fetchImpl })
  registerSpotifyAuthRoutes(app, { db: database, config, requireAuth, fetchImpl })
  registerYoutubeAuthRoutes(app, { db: database, config, requireAuth, fetchImpl })

  // Dashboard data/control routes require an authenticated session. Registered
  // in an encapsulated sub-context so the requireAuth preHandler hook applies
  // only to these routes, not to /healthz or the /auth/* OAuth routes above.
  await app.register(async (authenticated) => {
    authenticated.addHook('preHandler', requireAuth)
    await authenticated.register(stateRoutes, { botClient })
    await authenticated.register(linksRoutes, { db: database })
    await authenticated.register(controlRoutes, { botClient })
    await authenticated.register(queueRoutes, { botClient })
    await authenticated.register(importRoutes, { db: database, botClient })
    await authenticated.register(importEditRoutes, { db: database, botClient })
  })

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: false,
    })
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/auth/')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not_found' })
    })
  }

  let cleanupJob
  if (startCleanup) {
    cleanupJob = startCleanupJob({ db: database, logger: app.log })
    app.addHook('onClose', async () => cleanupJob.stop())
  }

  return app
}

export async function startWebServer({
  config = createWebConfig(),
  db,
  fetchImpl = globalThis.fetch,
} = {}) {
  const app = await buildWebServer({ config, db, fetchImpl })
  await app.listen({ host: config.host, port: config.port })
  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startWebServer()
}
