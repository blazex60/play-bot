import { appendFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { listLogFiles, logFileName, pruneLogs, utcDate } from './retention.js'

const MAX_BUFFER_BYTES = 1024 * 1024
const WARN_INTERVAL_MS = 60_000

/**
 * Pino-compatible destination (`write(string)`) that appends JSON Lines to
 * `<dir>/YYYY-MM-DD[.n].jsonl`, rotating by UTC date and size, and pruning
 * expired files at startup and on a timer.
 *
 * Writes are buffered and flushed in batches so logging never blocks the
 * audio path per line. I/O failures never throw: they are reported on stderr
 * (rate limited) and the process keeps running.
 */
export class RotatingFileStream {
  #dir
  #maxFileBytes
  #maxFilesPerDay
  #retentionDays
  #maxTotalBytes
  #now
  #warn
  #flushIntervalMs
  #buffer = []
  #bufferBytes = 0
  #flushTimer = null
  #cleanupTimer = null
  #active = null // { date, index, size }
  #lastWarnAt = 0
  #dropped = 0
  #closed = false

  constructor({
    dir,
    maxFileBytes = 10 * 1024 * 1024,
    maxFilesPerDay = 5,
    retentionDays = 7,
    maxTotalBytes = Infinity,
    cleanupIntervalMs = 60 * 60 * 1000,
    flushIntervalMs = 200,
    now = () => Date.now(),
    warn = message => process.stderr.write(`${message}\n`),
  } = {}) {
    if (!dir) throw new Error('RotatingFileStream: dir is required')
    this.#dir = dir
    this.#maxFileBytes = maxFileBytes
    this.#maxFilesPerDay = Math.max(1, maxFilesPerDay)
    this.#retentionDays = retentionDays
    this.#maxTotalBytes = maxTotalBytes
    this.#now = now
    this.#warn = warn
    this.#flushIntervalMs = flushIntervalMs

    this.#ensureDir()
    this.cleanup()
    if (cleanupIntervalMs > 0) {
      this.#cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs)
      this.#cleanupTimer.unref?.()
    }
  }

  get activeFileName() {
    return this.#active ? logFileName(this.#active.date, this.#active.index) : null
  }

  write(chunk) {
    if (this.#closed) return true
    const text = typeof chunk === 'string' ? chunk : String(chunk)
    const bytes = Buffer.byteLength(text)
    if (this.#bufferBytes + bytes > MAX_BUFFER_BYTES) {
      this.#dropped += 1
      this.#reportDropped()
      return true
    }
    this.#buffer.push(text)
    this.#bufferBytes += bytes
    if (this.#bufferBytes >= 64 * 1024) {
      this.flushSync()
    } else if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => this.flushSync(), this.#flushIntervalMs)
      this.#flushTimer.unref?.()
    }
    return true
  }

  flushSync() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    if (this.#buffer.length === 0) return
    const lines = this.#buffer
    this.#buffer = []
    this.#bufferBytes = 0
    try {
      this.#ensureDir()
      // Lines are grouped per target file so a batch never straddles rotation.
      let batch = ''
      let batchFile = null
      for (const line of lines) {
        const bytes = Buffer.byteLength(line)
        const { rotated } = this.#target(bytes)
        if (rotated) {
          // Land the previous file on disk first so generation counting is accurate.
          if (batch) this.#append(batch, batchFile)
          batch = ''
          this.#enforceGenerations(this.#active.date)
        }
        batchFile = { date: this.#active.date, index: this.#active.index }
        batch += line
        this.#active.size += bytes
      }
      if (batch) this.#append(batch, batchFile)
    } catch (error) {
      this.#active = null
      this.#reportError(error)
    }
  }

  cleanup() {
    try {
      const result = pruneLogs({
        dir: this.#dir,
        now: this.#now(),
        retentionDays: this.#retentionDays,
        maxTotalBytes: this.#maxTotalBytes,
        protect: this.activeFileName ? [this.activeFileName] : [],
      })
      if (result.failed.length) this.#reportError(new Error(`failed to delete ${result.failed.length} log file(s)`))
      return result
    } catch (error) {
      this.#reportError(error)
      return { deleted: [], failed: [], totalBytes: 0 }
    }
  }

  close() {
    this.flushSync()
    this.#closed = true
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer)
    this.#cleanupTimer = null
  }

  // Alias so it can be used wherever a pino destination `end()` is expected.
  end() {
    this.close()
  }

  #ensureDir() {
    mkdirSync(this.#dir, { recursive: true })
  }

  #append(text, file) {
    appendFileSync(join(this.#dir, logFileName(file.date, file.index)), text)
  }

  /** Pick (and if necessary rotate to) the file for the next line. */
  #target(bytes) {
    const date = utcDate(this.#now())
    const previous = this.#active ? { ...this.#active } : null
    let rotated = false

    if (!this.#active || this.#active.date !== date) {
      this.#active = this.#resume(date)
      rotated = Boolean(previous)
    }
    if (this.#active.size > 0 && this.#active.size + bytes > this.#maxFileBytes) {
      this.#active = { date, index: this.#active.index + 1, size: 0 }
      rotated = true
    }
    return { rotated, previous }
  }

  /** Continue the newest existing file of `date` (restart-safe), or start fresh. */
  #resume(date) {
    const existing = listLogFiles(this.#dir).filter(f => f.date === date)
    if (existing.length === 0) return { date, index: 0, size: 0 }
    const newest = existing[existing.length - 1]
    let size = newest.size
    try {
      size = statSync(newest.path).size
    } catch { /* use listed size */ }
    return { date, index: newest.index, size }
  }

  #enforceGenerations(date) {
    const todays = listLogFiles(this.#dir).filter(f => f.date === date)
    // The file about to be created counts as one generation.
    const excess = todays.length + 1 - this.#maxFilesPerDay
    for (let i = 0; i < excess; i += 1) {
      try {
        unlinkSync(todays[i].path)
      } catch { /* ignore */ }
    }
  }

  #reportError(error) {
    const now = Date.now()
    if (now - this.#lastWarnAt < WARN_INTERVAL_MS) return
    this.#lastWarnAt = now
    this.#warn(`[logging] file sink unavailable (${this.#dir}): ${error?.code ?? ''} ${error?.message ?? error}`)
  }

  #reportDropped() {
    this.#reportError(new Error(`log buffer full, ${this.#dropped} line(s) dropped`))
  }
}
