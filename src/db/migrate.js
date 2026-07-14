import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDatabase } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, 'migrations')

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
}

export function runMigrations(db = getDatabase()) {
  ensureMigrationTable(db)
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version)
  )

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort()

  const applyMigration = db.transaction(file => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec(sql)
    db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)'
    ).run(file, Date.now())
  })

  let appliedCount = 0
  for (const file of files) {
    if (applied.has(file)) continue
    applyMigration(file)
    appliedCount += 1
  }

  return { applied: appliedCount, total: files.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runMigrations()
  console.log(`MIGRATIONS_APPLIED=${result.applied}`)
}
