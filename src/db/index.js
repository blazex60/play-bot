import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB_PATH = join(__dirname, '..', '..', 'data', 'musicbot.db')

let database = null
let databasePath = process.env.MUSICBOT_DB_PATH ?? DEFAULT_DB_PATH

export function getDatabasePath() {
  return databasePath
}

export function configureDatabasePathForTest(path) {
  closeDatabase()
  databasePath = path
}

export function getDatabase() {
  if (database) return database

  mkdirSync(dirname(databasePath), { recursive: true })
  database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  return database
}

export function closeDatabase() {
  if (!database) return
  database.close()
  database = null
}

export function prepare(sql) {
  return getDatabase().prepare(sql)
}
