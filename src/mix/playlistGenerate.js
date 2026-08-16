import { optimizeTrackOrder } from './ordering.js';
import { probeTempoBackend } from '../audio/tempo.js';

export const DEFAULT_TARGET_COUNT = 10;
export const MIN_TARGET_COUNT = 3;
export const MAX_TARGET_COUNT = 25;
export const MIN_RESOLVED_RATIO = 0.5;
export const MAX_GENERATION_ATTEMPTS = 2;
/** Per-suggestion yt-dlp search bound so a hung child cannot pin generation slots. */
export const SEARCH_TIMEOUT_MS = 12_000;

/**
 * @param {string | null | undefined} prompt
 * @param {string} [fallback]
 */
export function defaultPlaylistName(prompt, fallback = 'MIX Playlist') {
  const trimmed = prompt?.trim();
  if (!trimmed) return fallback;
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 45)}...`;
}

/**
 * @param {{ title?: string, artist?: string }} suggestion
 * @returns {string | null}
 */
export function buildSearchQuery(suggestion) {
  const title = suggestion?.title?.trim();
  if (!title) return null;
  const artist = suggestion?.artist?.trim();
  return artist ? `${title} ${artist}` : title;
}

/**
 * @param {number} count
 */
export function clampTargetCount(count) {
  const n = Number.isFinite(count) ? Math.round(count) : DEFAULT_TARGET_COUNT;
  return Math.min(MAX_TARGET_COUNT, Math.max(MIN_TARGET_COUNT, n));
}

/**
 * Resolve Gemini suggestions to YouTube tracks. Misses are skipped silently.
 * @param {{
 *   suggestions: { title: string, artist?: string }[],
 *   searchYoutubeFn: (query: string) => Promise<object[]>,
 *   resolveYoutubeTrackFn: (entry: object, ctx: object) => { status: string, track?: object },
 *   requestedBy: string,
 *   requestedById?: string | null,
 *   searchTimeoutMs?: number,
 * }} args
 */
export async function resolveGeneratedTracks({
  suggestions,
  searchYoutubeFn,
  resolveYoutubeTrackFn,
  requestedBy,
  requestedById = null,
  searchTimeoutMs = SEARCH_TIMEOUT_MS,
}) {
  const tracks = [];
  const seen = new Set();
  for (const suggestion of suggestions) {
    const query = buildSearchQuery(suggestion);
    if (!query) continue;
    try {
      const entries = await searchYoutubeFn(query, { timeoutMs: searchTimeoutMs });
      if (!entries?.length) continue;
      const result = resolveYoutubeTrackFn(entries[0], { requestedBy, requestedById });
      if (result.status !== 'matched' || !result.track) continue;
      const key = result.track.videoId ?? result.track.webpageUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tracks.push(result.track);
    } catch {
      // Skip failed searches — plan requires silent exclusion.
    }
  }
  return tracks;
}

/**
 * @param {{
 *   prompt: string,
 *   targetCount?: number,
 *   gemini: { generateTrackList: Function } | null,
 *   searchYoutubeFn: Function,
 *   resolveYoutubeTrackFn: Function,
 *   optimizeTrackOrderFn?: typeof optimizeTrackOrder,
 *   loadAnalysisFn?: (videoId: string | null) => Promise<object | null> | object | null,
 *   probeTempoBackendFn?: typeof probeTempoBackend,
 *   requestedBy: string,
 *   requestedById?: string | null,
 * }} args
 */
export async function generatePlaylistFromPrompt({
  prompt,
  targetCount = DEFAULT_TARGET_COUNT,
  gemini,
  searchYoutubeFn,
  resolveYoutubeTrackFn,
  optimizeTrackOrderFn = optimizeTrackOrder,
  loadAnalysisFn = async () => null,
  probeTempoBackendFn = probeTempoBackend,
  requestedBy,
  requestedById = null,
}) {
  if (!gemini?.generateTrackList) return null;
  const trimmedPrompt = prompt?.trim();
  if (!trimmedPrompt) return null;

  const count = clampTargetCount(targetCount);
  const minResolved = Math.max(1, Math.floor(count * MIN_RESOLVED_RATIO));
  const seen = new Set();
  const accumulated = [];
  let excludeTitles = [];
  let playlistName = null;

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const remaining = Math.max(1, count - accumulated.length);
    const generated = await gemini.generateTrackList({
      prompt: trimmedPrompt,
      targetCount: remaining,
      excludeTitles,
    });
    if (!generated?.tracks?.length) break;

    playlistName = generated.playlistName ?? playlistName;
    const resolved = await resolveGeneratedTracks({
      suggestions: generated.tracks,
      searchYoutubeFn,
      resolveYoutubeTrackFn,
      requestedBy,
      requestedById,
      searchTimeoutMs: SEARCH_TIMEOUT_MS,
    });

    for (const track of resolved) {
      const key = track.videoId ?? track.webpageUrl;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      accumulated.push(track);
    }

    if (accumulated.length >= count) break;

    excludeTitles = [...new Set([
      ...excludeTitles,
      ...generated.tracks.map((t) => t.title).filter(Boolean),
    ])];
  }

  if (accumulated.length < minResolved) return null;

  const resolved = accumulated.slice(0, count);
  const analyses = await Promise.all(
    resolved.map((track) => loadAnalysisFn(track.videoId ?? null)),
  );
  // Probed once per generation call (memoized process-wide after the first
  // real probe, per tempo.js), so ordering's beatmix term can gate on
  // whether a marginal-tier or non-identity stretch is actually buildable
  // in THIS environment (Codex round-6 on PR #35).
  const tempoBackend = await probeTempoBackendFn();
  const order = optimizeTrackOrderFn({ tracks: resolved, analyses, tempoBackend });
  const ordered = order.map((idx) => resolved[idx]);

  return {
    playlistName: playlistName ?? defaultPlaylistName(trimmedPrompt),
    tracks: ordered,
    resolvedCount: ordered.length,
    requestedCount: count,
  };
}
