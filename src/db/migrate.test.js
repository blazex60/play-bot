import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from './migrate.js'

test('runMigrations applies 007 vocal columns', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const cols = db.prepare('PRAGMA table_info(track_analysis)').all().map((row) => row.name)
  assert.ok(cols.includes('last_vocal_end_sec'))
  assert.ok(cols.includes('vocal_gaps_json'))
  assert.ok(cols.includes('analysis_source'))
})

test('007 vocal columns can be reapplied when schema_migrations is missing', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  db.prepare("DELETE FROM schema_migrations WHERE version = '007_vocal_activity.sql'").run()
  const result = runMigrations(db)
  assert.equal(result.applied, 1)
  const cols = db.prepare('PRAGMA table_info(track_analysis)').all().map((row) => row.name)
  assert.ok(cols.includes('last_vocal_end_sec'))
})

test('runMigrations against createMemoryDb does not fail when 007 columns already exist', async () => {
  const { createMemoryDb } = await import('../web/server/testSupport.js')
  const db = createMemoryDb()
  const result = runMigrations(db)
  assert.ok(result.applied >= 1)
  const cols = db.prepare('PRAGMA table_info(track_analysis)').all().map((row) => row.name)
  assert.ok(cols.includes('last_vocal_end_sec'))
  assert.ok(cols.includes('vocal_gaps_json'))
  assert.ok(cols.includes('analysis_source'))
})

test('runMigrations applies 008 beatmix columns', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  const cols = db.prepare('PRAGMA table_info(track_analysis)').all().map((row) => row.name)
  assert.ok(cols.includes('downbeat_confidence'))
  assert.ok(cols.includes('phrase_confidence'))
  assert.ok(cols.includes('meter'))
})

test('008 beatmix columns can be reapplied when schema_migrations is missing', () => {
  const db = new Database(':memory:')
  runMigrations(db)
  db.prepare("DELETE FROM schema_migrations WHERE version = '008_beatmix_analysis.sql'").run()
  const result = runMigrations(db)
  assert.equal(result.applied, 1)
  const cols = db.prepare('PRAGMA table_info(track_analysis)').all().map((row) => row.name)
  assert.ok(cols.includes('downbeat_confidence'))
})

test('runMigrations against createMemoryDb does not fail when 008 columns already exist', async () => {
  const { createMemoryDb } = await import('../web/server/testSupport.js')
  const db = createMemoryDb()
  const result = runMigrations(db)
  assert.ok(result.applied >= 1)
  const cols = db.prepare('PRAGMA table_info(track_analysis)').all().map((row) => row.name)
  assert.ok(cols.includes('downbeat_confidence'))
  assert.ok(cols.includes('phrase_confidence'))
  assert.ok(cols.includes('meter'))
})
