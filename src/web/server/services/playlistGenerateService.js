import { generatePlaylistFromPrompt, defaultPlaylistName } from '../../../mix/playlistGenerate.js';
import { createPlaylist, getOwnedPlaylist, getPlaylistTracks, insertTrack, serializePlaylistRow, serializeTrackRow } from '../routes/playlists-db.js';

export const GENERATION_DEDUPE_TTL_MS = 120_000;

/** @type {Map<string, { playlistId: number, expiresAt: number }>} */
const recentGenerations = new Map();

/**
 * @param {{ userId: string, prompt: string, targetCount?: number, name?: string | null, idempotencyKey?: string | null }} args
 */
function generationDedupeKeys({ userId, prompt, targetCount, name, idempotencyKey }) {
  const contentKey = `content:${userId}\n${String(prompt ?? '').trim()}\n${targetCount ?? ''}\n${typeof name === 'string' ? name.trim() : ''}`;
  const keys = [contentKey];
  if (typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
    keys.unshift(`id:${idempotencyKey.trim()}`);
  }
  return keys;
}

function takeRecentPlaylistId(keys) {
  const now = Date.now();
  for (const key of keys) {
    const entry = recentGenerations.get(key);
    if (!entry) continue;
    if (now > entry.expiresAt) {
      recentGenerations.delete(key);
      continue;
    }
    return entry.playlistId;
  }
  return null;
}

function rememberGeneration(keys, playlistId) {
  const expiresAt = Date.now() + GENERATION_DEDUPE_TTL_MS;
  for (const key of keys) {
    recentGenerations.set(key, { playlistId, expiresAt });
  }
}

export function clearGeneratedPlaylistDedupe() {
  recentGenerations.clear();
}

function serializeSavedPlaylist(db, userId, id) {
  const playlist = getOwnedPlaylist(db, userId, id);
  const tracks = getPlaylistTracks(db, id).map(serializeTrackRow);
  return {
    ...serializePlaylistRow({ ...playlist, track_count: tracks.length }),
    tracks,
  };
}

/**
 * Create the playlist row and all track rows in one SQLite transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} playlistName
 * @param {object[]} tracks
 */
export function persistGeneratedPlaylist(db, userId, playlistName, tracks) {
  const persist = db.transaction(() => {
    const id = createPlaylist(db, userId, playlistName);
    for (const track of tracks) {
      insertTrack(db, id, track);
    }
    return id;
  });
  return persist();
}

/**
 * Generate tracks via Gemini + YouTube search, optimize order, persist to user_playlists.
 */
export async function createGeneratedUserPlaylist({
  db,
  gemini,
  userId,
  username,
  prompt,
  targetCount,
  name,
  idempotencyKey = null,
  searchYoutubeFn,
  resolveYoutubeTrackFn,
  loadAnalysisFn,
}) {
  const dedupeKeys = generationDedupeKeys({ userId, prompt, targetCount, name, idempotencyKey });
  const cachedId = takeRecentPlaylistId(dedupeKeys);
  if (cachedId != null) {
    try {
      const cached = serializeSavedPlaylist(db, userId, cachedId);
      return {
        ...cached,
        resolvedCount: cached.tracks.length,
        requestedCount: targetCount ?? cached.tracks.length,
      };
    } catch {
      // Playlist was deleted; generate a new one.
    }
  }

  const result = await generatePlaylistFromPrompt({
    prompt,
    targetCount,
    gemini,
    searchYoutubeFn,
    resolveYoutubeTrackFn,
    loadAnalysisFn,
    requestedBy: username,
    requestedById: userId,
  });

  if (!result?.tracks?.length) {
    const error = new Error('generation_failed');
    error.statusCode = 422;
    error.code = 'generation_failed';
    error.publicMessage = 'プレイリストの自動生成に失敗しました（Gemini または YouTube 検索を確認してください）';
    throw error;
  }

  const playlistName = (typeof name === 'string' && name.trim())
    ? name.trim()
    : (result.playlistName ?? defaultPlaylistName(prompt));

  const id = persistGeneratedPlaylist(db, userId, playlistName, result.tracks);
  rememberGeneration(dedupeKeys, id);

  return {
    ...serializeSavedPlaylist(db, userId, id),
    resolvedCount: result.resolvedCount,
    requestedCount: result.requestedCount,
  };
}
