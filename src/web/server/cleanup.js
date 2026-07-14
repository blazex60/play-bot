const DEFAULT_INTERVAL_MS = 10 * 60 * 1000

function deleteExpired(db, table, now) {
  const result = db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(now)
  return result.changes ?? 0
}

export function sweepExpiredRows({ db, now = Date.now() } = {}) {
  if (!db) {
    throw new Error('db is required')
  }
  return {
    oauthStates: deleteExpired(db, 'oauth_states', now),
    webSessions: deleteExpired(db, 'web_sessions', now),
  }
}

export function startCleanupJob({
  db,
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const run = () => {
    try {
      const deleted = sweepExpiredRows({ db, now: now() })
      logger.info?.({ event: 'web.cleanup.sweep', deleted })
    } catch (error) {
      logger.error?.({ event: 'web.cleanup.error', error: error.message })
    }
  }
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return {
    run,
    stop: () => clearInterval(timer),
  }
}
