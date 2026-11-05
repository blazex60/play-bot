import pino from 'pino'

import { resolveLoggingConfig } from './config.js'
import { REDACT_PATHS, scrubString, serializeError, serializeRequest, serializeResponse } from './redact.js'
import { RotatingFileStream } from './rotatingFileStream.js'

/**
 * Create the shared structured logger for a service ('music-bot' | 'music-web').
 *
 * Output is JSON Lines on stdout (for `docker compose logs`) and, when enabled,
 * rotated files under LOG_DIR. Never throws on file-sink problems.
 */
export function createLogger(service, {
  env = process.env,
  config = resolveLoggingConfig(env),
  stdout = process.stdout,
  now,
} = {}) {
  if (!service) throw new Error('createLogger: service is required')

  const streams = []
  let fileStream = null

  if (config.stdoutEnabled) {
    streams.push({ level: 'trace', stream: stdout })
  }
  if (config.fileEnabled) {
    try {
      fileStream = new RotatingFileStream({
        dir: `${config.dir}/${service}`,
        maxFileBytes: config.maxFileBytes,
        maxFilesPerDay: config.maxFilesPerDay,
        retentionDays: config.retentionDays,
        maxTotalBytes: config.maxTotalBytes,
        cleanupIntervalMs: config.cleanupIntervalMs,
        ...(now ? { now } : {}),
      })
      streams.push({ level: 'trace', stream: fileStream })
    } catch (error) {
      process.stderr.write(`[logging] file sink disabled for ${service}: ${error?.message ?? error}\n`)
    }
  }

  const logger = pino(
    {
      level: config.level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: {
        // pino derives `msg` from err.message when none is given, bypassing
        // serializers, so scrub free-form message text here.
        logMethod(args, method) {
          const [first, second] = args
          if (typeof first === 'string') args[0] = scrubString(first)
          else if (typeof second === 'string') args[1] = scrubString(second)
          else if (second === undefined && first?.err instanceof Error) args[1] = scrubString(first.err.message)
          method.apply(this, args)
        },
      },
      formatters: { level: label => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        err: serializeError,
        error: serializeError,
        req: serializeRequest,
        res: serializeResponse,
      },
    },
    streams.length === 0 ? { write() {} } : pino.multistream(streams),
  )

  /** Flush buffered lines synchronously (call from exit/fatal handlers). */
  const flush = () => fileStream?.flushSync()
  const close = () => fileStream?.close()
  return Object.assign(logger, { flushLogs: flush, closeLogs: close })
}

export { resolveLoggingConfig }
