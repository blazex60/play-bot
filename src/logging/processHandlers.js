const installed = new WeakSet()

/**
 * Log uncaught errors / unhandled rejections / termination signals and flush
 * buffered lines before the process goes away. Call once per entrypoint.
 * `onShutdown` (optional, may be async) runs before exit on SIGTERM/SIGINT.
 */
export function installProcessHandlers(logger, { exit = code => process.exit(code), proc = process, onShutdown = null, shutdownTimeoutMs = 8000 } = {}) {
  if (installed.has(logger)) return
  installed.add(logger)
  const log = logger.child({ component: 'process' })
  const flush = () => logger.flushLogs?.()

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
  let shuttingDown = false
  for (const signal of ['SIGTERM', 'SIGINT']) {
    proc.on(signal, async () => {
      if (shuttingDown) {
        // A second signal means "stop waiting".
        log.warn({ event: 'process.shutdown_forced', signal })
        flush()
        exit(1)
        return
      }
      shuttingDown = true
      log.info({ event: 'process.shutdown', signal })
      let timer
      try {
        // Bounded so a hung close() cannot outlive `docker stop`'s grace period.
        await Promise.race([
          Promise.resolve().then(() => onShutdown?.()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`shutdown exceeded ${shutdownTimeoutMs}ms`)), shutdownTimeoutMs)
            timer.unref?.()
          }),
        ])
      } catch (err) {
        log.error({ event: 'process.shutdown_error', err })
      } finally {
        clearTimeout(timer)
      }
      flush()
      exit(0)
    })
  }
  proc.on('exit', flush)
}
