import { createLogger } from './logger.js'

let base = null
const children = new Map()

/** Lazily-created process-wide logger for the music-bot service. */
export function getBotLogger() {
  base ??= createLogger('music-bot')
  return base
}

/** Child logger tagged with `component` (cached). Safe to call at import time. */
export function getLogger(component) {
  let child = children.get(component)
  if (!child) {
    child = getBotLogger().child({ component })
    children.set(component, child)
  }
  return child
}

let handlersInstalled = false

/**
 * Log uncaught errors / unhandled rejections / termination signals and flush
 * buffered lines before the process goes away. Call once from the entrypoint.
 */
export function installProcessHandlers({ exit = code => process.exit(code), proc = process } = {}) {
  if (handlersInstalled) return
  handlersInstalled = true
  const log = getLogger('process')
  const flush = () => getBotLogger().flushLogs?.()

  proc.on('uncaughtException', err => {
    log.fatal({ event: 'process.uncaught_exception', err })
    flush()
    exit(1)
  })
  proc.on('unhandledRejection', reason => {
    // Preserves Node's default (crash, exit 1) but leaves a record on disk first.
    log.fatal({ event: 'process.unhandled_rejection', err: reason instanceof Error ? reason : new Error(String(reason)) })
    flush()
    exit(1)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    proc.on(signal, () => {
      log.info({ event: 'process.shutdown', signal })
      flush()
      exit(0)
    })
  }
  proc.on('exit', flush)
}
