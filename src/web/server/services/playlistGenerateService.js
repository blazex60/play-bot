import { generatePlaylistFromPrompt, defaultPlaylistName } from '../../../mix/playlistGenerate.js';
import { createPlaylist, getOwnedPlaylist, getPlaylistTracks, insertTrack, serializePlaylistRow, serializeTrackRow } from '../routes/playlists-db.js';

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
  searchYoutubeFn,
  resolveYoutubeTrackFn,
  loadAnalysisFn,
}) {
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

  const id = createPlaylist(db, userId, playlistName);
  for (const track of result.tracks) {
    insertTrack(db, id, track);
  }

  const playlist = getOwnedPlaylist(db, userId, id);
  const tracks = getPlaylistTracks(db, id).map(serializeTrackRow);

  return {
    ...serializePlaylistRow({ ...playlist, track_count: tracks.length }),
    tracks,
    resolvedCount: result.resolvedCount,
    requestedCount: result.requestedCount,
  };
}
