import { generatePlaylistFromPrompt, defaultPlaylistName } from '../../../mix/playlistGenerate.js';
import { createPlaylist, getOwnedPlaylist, getPlaylistTracks, insertTrack, serializePlaylistRow, serializeTrackRow } from '../routes/playlists-db.js';

export const GENERATION_DEDUPE_TTL_MS = 120_000;
export const GENERATION_DEDUPE_MAX_ENTRIES = 256;

let dedupeMaxEntries = GENERATION_DEDUPE_MAX_ENTRIES;

/** @type {Map<string, { playlistId: number, requestedCount: number, expiresAt: number }>} */
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

function sweepExpiredGenerations(now = Date.now()) {
  for (const [key, entry] of recentGenerations) {
    if (now > entry.expiresAt) recentGenerations.delete(key);
  }
}

function evictOverflow() {
  while (recentGenerations.size > dedupeMaxEntries) {
    const oldestKey = recentGenerations.keys().next().value;
    recentGenerations.delete(oldestKey);
  }
}

function takeRecentGeneration(keys) {
  sweepExpiredGenerations();
  for (const key of keys) {
    const entry = recentGenerations.get(key);
    if (entry) return entry;
  }
  return null;
}

function rememberGeneration(keys, playlistId, requestedCount) {
  const now = Date.now();
  sweepExpiredGenerations(now);
  const expiresAt = now + GENERATION_DEDUPE_TTL_MS;
  const payload = { playlistId, requestedCount, expiresAt };
  for (const key of keys) {
    recentGenerations.delete(key);
    recentGenerations.set(key, payload);
  }
  evictOverflow();
}

export function clearGeneratedPlaylistDedupe({ maxEntries } = {}) {
  recentGenerations.clear();
  dedupeMaxEntries = maxEntries ?? GENERATION_DEDUPE_MAX_ENTRIES;
}

export function getGeneratedPlaylistDedupeSize() {
  return recentGenerations.size;
}

export function sweepGeneratedPlaylistDedupe(now = Date.now()) {
  sweepExpiredGenerations(now);
  evictOverflow();
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
  const cached = takeRecentGeneration(dedupeKeys);
  if (cached != null) {
    try {
      const playlist = serializeSavedPlaylist(db, userId, cached.playlistId);
      return {
        ...playlist,
        resolvedCount: playlist.tracks.length,
        requestedCount: cached.requestedCount,
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
  rememberGeneration(dedupeKeys, id, result.requestedCount);

  return {
    ...serializeSavedPlaylist(db, userId, id),
    resolvedCount: result.resolvedCount,
    requestedCount: result.requestedCount,
  };
}
