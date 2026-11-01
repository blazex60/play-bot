import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIB = 1024 * 1024
const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return !/^(0|false|no|off)$/i.test(String(value).trim())
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * Resolve logging settings from environment variables.
 * File output is off under NODE_ENV=test unless LOG_FILE_ENABLED is explicit.
 */
export function resolveLoggingConfig(env = process.env) {
  const rawLevel = String(env.LOG_LEVEL ?? '').trim().toLowerCase()
  const level = LEVELS.has(rawLevel) ? rawLevel : 'info'
  // node --test sets NODE_TEST_CONTEXT in test processes.
  const isTest = env.NODE_ENV === 'test' || Boolean(env.NODE_TEST_CONTEXT)
  return {
    level,
    dir: env.LOG_DIR ? resolve(env.LOG_DIR) : join(projectRoot, 'logs'),
    fileEnabled: parseBool(env.LOG_FILE_ENABLED, !isTest),
    stdoutEnabled: parseBool(env.LOG_STDOUT_ENABLED, !isTest),
    retentionDays: parsePositiveInt(env.LOG_RETENTION_DAYS, 7),
    maxFileBytes: parsePositiveInt(env.LOG_MAX_FILE_MIB, 10) * MIB,
    maxFilesPerDay: parsePositiveInt(env.LOG_MAX_FILES_PER_DAY, 5),
    maxTotalBytes: parsePositiveInt(env.LOG_MAX_TOTAL_MIB, 500) * MIB,
    cleanupIntervalMs: parsePositiveInt(env.LOG_CLEANUP_INTERVAL_MIN, 60) * 60 * 1000,
  }
}
