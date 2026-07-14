import { getDatabase } from './index.js'
import { runMigrations } from './migrate.js'

const TABLES = [
  'discord_users',
  'web_sessions',
  'service_links',
  'oauth_states',
  'import_jobs',
  'import_tracks',
]

function inspect() {
  const db = getDatabase()
  runMigrations(db)

  console.log('musicbot.db')
  for (const table of TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
    console.log(`${table}: ${row.count}`)
  }
}

inspect()
