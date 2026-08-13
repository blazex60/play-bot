import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryDb } from '../testSupport.js'
import {
  clearGeneratedPlaylistDedupe,
  createGeneratedUserPlaylist,
  persistGeneratedPlaylist,
} from './playlistGenerateService.js'

function seedUser(db, discordId = 'u1') {
  db.prepare(`INSERT INTO discord_users (discord_id, username, created_at, last_seen_at) VALUES (?, ?, 1, 1)`).run(discordId, discordId)
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

test('createGeneratedUserPlaylist reuses a recent idempotency key instead of inserting twice', async (t) => {
  clearGeneratedPlaylistDedupe()
  t.after(() => clearGeneratedPlaylistDedupe())
  const db = createMemoryDb()
  t.after(() => db.close())
  seedUser(db)

  const gemini = {
    available: true,
    async generateTrackList() {
      return { playlistName: 'Reuse', tracks: [{ title: 'A' }] }
    },
  }
  const args = {
    db,
    gemini,
    userId: 'u1',
    username: 'tester',
    prompt: 'reuse me',
    targetCount: 3,
    idempotencyKey: 'same-key',
    searchYoutubeFn: async () => [{ id: 'vid-1', title: 'A' }],
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.title, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    loadAnalysisFn: async () => null,
  }

  const first = await createGeneratedUserPlaylist(args)
  const second = await createGeneratedUserPlaylist(args)
  assert.equal(first.id, second.id)
  const count = db.prepare('SELECT COUNT(*) AS n FROM user_playlists').get().n
  assert.equal(count, 1)
})
