import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryDb } from '../testSupport.js'
import {
  GENERATION_DEDUPE_TTL_MS,
  clearGeneratedPlaylistDedupe,
  createGeneratedUserPlaylist,
  getGeneratedPlaylistDedupeSize,
  persistGeneratedPlaylist,
  sweepGeneratedPlaylistDedupe,
} from './playlistGenerateService.js'

process.env.MUSICBOT_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64')

function seedUser(db, discordId = 'u1') {
  db.prepare(`INSERT INTO discord_users (discord_id, username, created_at, last_seen_at) VALUES (?, ?, 1, 1)`).run(discordId, discordId)
}

function generateArgs(db, overrides = {}) {
  return {
    db,
    gemini: {
      available: true,
      async generateTrackList() {
        return { playlistName: 'Reuse', tracks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }
      },
    },
    userId: 'u1',
    username: 'tester',
    prompt: 'reuse me',
    targetCount: 4,
    idempotencyKey: 'same-key',
    searchYoutubeFn: async (query) => [{ id: query, title: query }],
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.title, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    loadAnalysisFn: async () => null,
    ...overrides,
  }
}

test('persistGeneratedPlaylist rolls back the playlist when a later track insert fails', (t) => {
  const db = createMemoryDb()
  t.after(() => db.close())
  seedUser(db)

  assert.throws(() => persistGeneratedPlaylist(db, 'u1', 'Partial', [
    { title: 'Good', webpageUrl: 'https://youtu.be/a', videoId: 'a' },
    { title: null, webpageUrl: 'https://youtu.be/b', videoId: 'b' },
  ]))

  const playlists = db.prepare('SELECT * FROM user_playlists').all()
  const tracks = db.prepare('SELECT * FROM user_playlist_tracks').all()
  assert.equal(playlists.length, 0)
  assert.equal(tracks.length, 0)
})

test('createGeneratedUserPlaylist reuses a recent idempotency key and preserves requestedCount', async (t) => {
  clearGeneratedPlaylistDedupe()
  t.after(() => clearGeneratedPlaylistDedupe())
  const db = createMemoryDb()
  t.after(() => db.close())
  seedUser(db)

  const args = generateArgs(db)
  const first = await createGeneratedUserPlaylist(args)
  assert.equal(first.tracks.length, 3)
  assert.equal(first.requestedCount, 4)

  const second = await createGeneratedUserPlaylist({ ...args, targetCount: 99 })
  assert.equal(second.id, first.id)
  assert.equal(second.requestedCount, 4)
  const count = db.prepare('SELECT COUNT(*) AS n FROM user_playlists').get().n
  assert.equal(count, 1)
})

test('generation dedupe sweeps expired entries without waiting for the same key', async (t) => {
  clearGeneratedPlaylistDedupe()
  t.after(() => clearGeneratedPlaylistDedupe())
  const db = createMemoryDb()
  t.after(() => db.close())
  seedUser(db)

  await createGeneratedUserPlaylist(generateArgs(db, { idempotencyKey: 'expire-me' }))
  assert.ok(getGeneratedPlaylistDedupeSize() > 0)
  sweepGeneratedPlaylistDedupe(Date.now() + GENERATION_DEDUPE_TTL_MS + 1)
  assert.equal(getGeneratedPlaylistDedupeSize(), 0)
})

test('generation dedupe evicts oldest entries when over capacity', async (t) => {
  clearGeneratedPlaylistDedupe({ maxEntries: 2 })
  t.after(() => clearGeneratedPlaylistDedupe())
  const db = createMemoryDb()
  t.after(() => db.close())
  seedUser(db)

  const first = await createGeneratedUserPlaylist(generateArgs(db, { prompt: 'one', idempotencyKey: 'k1' }))
  await createGeneratedUserPlaylist(generateArgs(db, { prompt: 'two', idempotencyKey: 'k2' }))
  assert.ok(getGeneratedPlaylistDedupeSize() <= 2)

  const replay = await createGeneratedUserPlaylist(generateArgs(db, { prompt: 'one', idempotencyKey: 'k1' }))
  assert.notEqual(replay.id, first.id)
})
