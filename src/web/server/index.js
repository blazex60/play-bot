import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { LogController } from 'fastify'
import { randomUUID } from 'node:crypto'
import { getAppLogger, getLogger, installProcessHandlers, setLogService } from '../../logging/appLogger.js'
import { createBotClient } from './botClient.js'
import { startCleanupJob } from './cleanup.js'
import { createWebConfig, defaultConfig } from './config.js'
import { registerDiscordAuthRoutes } from './auth/discord.js'
import { registerDemoAuthRoutes } from './auth/demo.js'
import { registerYoutubeAuthRoutes } from './auth/youtube.js'
import { createRequireAuth } from './middleware/requireAuth.js'
import { runMigrations } from '../db/migrate.js'
import { stateRoutes } from './routes/state.js'
import { linksRoutes } from './routes/links.js'
import { controlRoutes } from './routes/control.js'
import { queueRoutes } from './routes/queue.js'
import { importRoutes } from './routes/import.js'
import { importEditRoutes } from './routes/import-edit.js'
import { playlistsRoutes } from './routes/playlists.js'
import { internalRoutes } from './routes/internal.js'
import { adminRoutes } from './routes/admin.js'

const thisDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(thisDir, '../../..')
const webDist = join(projectRoot, 'web/dist')

async function loadDefaultDb() {
  const dbModule = await import('../db/index.js')
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
  logger,
  startCleanup = true,
} = {}) {
  // logger: false -> silent (tests); a pino-compatible instance -> used as is;
  // undefined/true -> the shared music-web logger (stdout + rotated files).
  if (logger !== false && !(logger && typeof logger === 'object')) setLogService('music-web')
  const loggerOptions = logger === false
    ? { logger: false }
    : { loggerInstance: logger && typeof logger === 'object' ? logger : getAppLogger() }
  const app = Fastify({
    ...loggerOptions,
    // Request lines are emitted by the onResponse hook below (route pattern,
    // no raw URL/query), so Fastify's own incoming/completed lines are off.
    logController: new LogController({ disableRequestLogging: true }),
    // Never trust a client-supplied request id; generate our own.
    genReqId: () => randomUUID(),
    trustProxy: config.trustProxy,
  })

  app.addHook('onRequest', async (request) => {
    request.startedAt = process.hrtime.bigint()
  })
  // disableRequestLogging also silences Fastify's default error-handler lines,
  // so unexpected (5xx) errors are logged explicitly with their stack.
  app.addHook('onError', async (request, _reply, err) => {
    // Errors without a statusCode become 500s (reply.statusCode is still 200 here).
    const status = err?.statusCode ?? 500
    if (status >= 500) {
      request.log.error({ event: 'web.request_error', method: request.method, route: request.routeOptions?.url ?? 'unmatched', err })
    }
  })
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url
    if (route === '/healthz') return
    const status = reply.statusCode
    const durationMs = Math.round(Number(process.hrtime.bigint() - request.startedAt) / 1e6)
    // Dashboard polling GETs are frequent: keep successes at debug.
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : request.method === 'GET' ? 'debug' : 'info'
    request.log[level]({ event: 'web.request', method: request.method, route: route ?? 'unmatched', status, durationMs })
  })
  const database = db ?? await loadDefaultDb()
  const migration = runMigrations(database)
  app.log.info({ event: 'web.db.migrated', applied: migration.applied, total: migration.total })

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
      youtube: config.oauth.youtube.redirectUri,
    },
  }))

  app.get('/api/me', { preHandler: requireAuth }, async (request) => ({
    user: request.user,
  }))

  // Bot -> Web internal channel (play history), token-guarded, independent
  // of the browser cookie-session requireAuth hook used below.
  await app.register(internalRoutes, {
    db: database,
    token: config.botApi.token,
  })

  registerDiscordAuthRoutes(app, { db: database, config, fetchImpl })
  registerDemoAuthRoutes(app, { db: database, config })
  registerYoutubeAuthRoutes(app, { db: database, config, requireAuth, fetchImpl })

  // Dashboard data/control routes require an authenticated session. Registered
  // in an encapsulated sub-context so the requireAuth preHandler hook applies
  // only to these routes, not to /healthz or the /auth/* OAuth routes above.
  await app.register(async (authenticated) => {
    authenticated.addHook('preHandler', requireAuth)
    await authenticated.register(stateRoutes, { botClient })
    await authenticated.register(linksRoutes, { db: database })
    await authenticated.register(controlRoutes, { botClient, db: database })
    await authenticated.register(queueRoutes, { botClient, db: database })
    await authenticated.register(importRoutes, { db: database, botClient })
    await authenticated.register(importEditRoutes, { db: database, botClient })
    await authenticated.register(playlistsRoutes, { db: database, botClient })
    await authenticated.register(adminRoutes, { db: database, botClient })
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
  setLogService('music-web')
  let app
  const log = getLogger('web')
  installProcessHandlers({ onShutdown: () => app?.close() })
  log.info({ event: 'web.starting', nodeVersion: process.version, pid: process.pid })
  try {
    app = await buildWebServer({ config, db, fetchImpl })
    await app.listen({ host: config.host, port: config.port })
  } catch (err) {
    log.fatal({ event: 'web.start_failed', err })
    getAppLogger().flushLogs?.()
    throw err
  }
  log.info({ event: 'web.listening', host: config.host, port: config.port })
  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startWebServer()
}
