import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// YYYY-MM-DD.jsonl or YYYY-MM-DD.<n>.jsonl
const FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/

export function parseLogFileName(name) {
  const m = FILE_RE.exec(name)
  if (!m) return null
  return { date: m[1], index: m[2] === undefined ? 0 : Number(m[2]) }
}

export function logFileName(date, index) {
  return index === 0 ? `${date}.jsonl` : `${date}.${index}.jsonl`
}

export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

export function listLogFiles(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files = []
  for (const name of names) {
    const parsed = parseLogFileName(name)
    if (!parsed) continue
    try {
      const st = statSync(join(dir, name))
      if (st.isFile()) files.push({ name, path: join(dir, name), size: st.size, ...parsed })
    } catch { /* raced with deletion */ }
  }
  // oldest first
  files.sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index)
  return files
}

/**
 * Delete expired log files (UTC-date based, today + previous retentionDays-1
 * days are kept), then trim oldest files while total size exceeds
 * maxTotalBytes. Files named in `protect` (the active file) are never removed.
 */
export function pruneLogs({
  dir,
  now = Date.now(),
  retentionDays = 7,
  maxTotalBytes = Infinity,
  protect = [],
  remove = unlinkSync,
} = {}) {
  const protectedNames = new Set(protect)
  const cutoff = utcDate(now - (retentionDays - 1) * 86_400_000)
  const files = listLogFiles(dir)
  const deleted = []
  const failed = []
  const tryRemove = (file, reason) => {
    try {
      remove(file.path)
      deleted.push({ name: file.name, reason })
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      failed.push({ name: file.name, error: error?.message })
      return false
    }
  }

  const kept = []
  for (const file of files) {
    if (file.date < cutoff && !protectedNames.has(file.name)) {
      if (!tryRemove(file, 'expired')) kept.push(file)
    } else {
      kept.push(file)
    }
  }

  let total = kept.reduce((sum, f) => sum + f.size, 0)
  for (const file of kept) {
    if (total <= maxTotalBytes) break
    if (protectedNames.has(file.name)) continue
    if (tryRemove(file, 'disk-cap')) total -= file.size
  }
  return { deleted, failed, totalBytes: total }
}
