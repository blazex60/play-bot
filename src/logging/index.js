import pino from 'pino'
import { mkdir, readdir, stat, appendFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DAY = 86400000
const NAME = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

// A bounded asynchronous queue keeps filesystem stalls away from the audio path.
export function createFileSink({ directory, now = () => Date.now(), maxBytes = 10 * 1024 * 1024, maxFiles = 5, retentionDays = 7, warn = () => process.stderr.write('log file unavailable; continuing on stdout\n') }) {
  let pending = Promise.resolve()
  let queued = 0
  let lastWarning = 0
  let lastCleanup = 0
  const warning = () => { if (!lastWarning || Date.now() - lastWarning > 60000) { lastWarning = Date.now(); warn() } }
  async function cleanup(time) {
    await mkdir(directory, { recursive: true })
    const cutoff = new Date(Math.floor(time / DAY) * DAY - (retentionDays - 1) * DAY).toISOString().slice(0, 10)
    for (const name of await readdir(directory)) {
      const match = NAME.exec(name)
      if (match && match[1] < cutoff) await unlink(join(directory, name)).catch(() => {})
    }
    lastCleanup = time
  }
  async function append(line, time) {
    if (!lastCleanup || time - lastCleanup >= 3600000 || time < lastCleanup) await cleanup(time)
    const date = new Date(time).toISOString().slice(0, 10)
    const bytes = Buffer.byteLength(line)
    if (bytes > maxBytes) { warning(); return }
    for (let i = 0; i < maxFiles; i++) {
      const path = join(directory, `${date}${i ? `.${i}` : ''}.jsonl`)
      let size = 0
      try { size = (await stat(path)).size } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (size + bytes <= maxBytes) { await appendFile(path, line, { mode: 0o600 }); return }
    }
    // Keep a hard daily cap; do not remove a file that may be in use.
    warning()
  }
  const timer = setInterval(() => { pending = pending.then(() => cleanup(now())).catch(warning) }, 3600000)
  timer.unref()
  return {
    write(line) {
      const bytes = Buffer.byteLength(line)
      if (queued + bytes > 1024 * 1024) { warning(); return }
      queued += bytes
      const time = now()
      pending = pending.then(() => append(line, time)).catch(warning).finally(() => { queued -= bytes })
    },
    flush: () => pending,
    cleanup: () => { pending = pending.then(() => cleanup(now())).catch(warning); return pending },
  }
}

export function createLogger({ service, level = process.env.LOG_LEVEL || 'info', logDir = process.env.LOG_DIR || './logs', stdout = process.stdout, fileSink } = {}) {
  if (!['music-bot', 'music-web'].includes(service)) throw new Error('invalid logging service')
  const sink = fileSink ?? createFileSink({ directory: join(logDir, service) })
  const stream = { write(line) { stdout.write(line); sink.write(line) } }
  const logger = pino({
    level,
    base: { service },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: label => ({ level: label }) },
    hooks: { logMethod(args, method) {
      if (args[0] instanceof Error) args = [{ err: args[0] }, '']
      else if (args[0] && typeof args[0] === 'object' && args[0].err) {
        if (args.length === 1) args.push('')
        else args[1] = ''
      }
      return method.apply(this, args)
    } },
    // Exceptions can include URLs, tokens, user content and upstream responses.
    serializers: { err: err => ({ type: err?.name || 'Error', ...(typeof err?.code === 'string' && /^[A-Z0-9_]+$/.test(err.code) ? { code: err.code } : {}) }) },
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'authorization', 'cookie', 'password', 'token', 'access_token', 'refresh_token'], censor: '[Redacted]' },
  }, stream)
  return { logger, flush: () => sink.flush(), cleanup: () => sink.cleanup() }
}

// Route templates contain no query string, path parameters, headers or bodies.
export function installRequestLogging(app, prefix) {
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url
    if (route === '/healthz') return
    request.log.info({ event: `${prefix}.request.completed`, requestId: request.id, method: request.method, route: route || 'unmatched', statusCode: reply.statusCode, durationMs: reply.elapsedTime })
  })
}

// Keep fatal reporting independent from application shutdown logic. A deadline
// prevents a stalled filesystem from keeping a broken process alive forever.
export function installFatalLogging(logs) {
  let terminating = false
  const fatal = (event, err) => {
    if (terminating) return
    terminating = true
    logs.logger.fatal({ event, err: err instanceof Error ? err : new Error('Non-error rejection') })
    const deadline = setTimeout(() => process.exit(1), 2000)
    deadline.unref()
    logs.flush().finally(() => process.exit(1))
  }
  process.on('uncaughtException', err => fatal('process.uncaught_exception', err))
  process.on('unhandledRejection', err => fatal('process.unhandled_rejection', err))
}
