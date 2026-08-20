import { spawn } from 'node:child_process';
import { createTrack } from './queue.js';

export class YtdlpError extends Error {}

/**
 * Node solves YouTube n-sig / PO-token JS challenges (required since 2025).
 * --no-cache-dir avoids a stale player-JS cache, which googlevideo serves as
 * HTTP 403 rather than "signature expired".
 * android_sdkless / web_safari progressive and m3u8 URLs currently 403
 * (yt-dlp#15712, yt-dlp#15569); drop them from the default client set.
 */
export const YTDLP_EXTRACTOR_ARGS = 'youtube:player_client=default,-android_sdkless,-web_safari';
/** Prefer a progressive HTTPS audio stream; fall back to whatever remains. */
export const YTDLP_AUDIO_FORMAT = 'bestaudio[protocol^=http]/bestaudio/best';

export function ytdlpCookieArgs(env = process.env) {
  const file = env.YTDLP_COOKIES_FILE?.trim();
  return file ? ['--cookies', file] : [];
}

export function buildYtdlpArgs(...args) {
  return [
    '--js-runtimes', 'node',
    '--no-cache-dir',
    '--extractor-args', YTDLP_EXTRACTOR_ARGS,
    ...ytdlpCookieArgs(),
    ...args,
  ];
}

export function spawnAsync(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          proc.kill('SIGKILL');
          settle(() => reject(new YtdlpError(`yt-dlp timed out after ${timeoutMs}ms`)));
        }, timeoutMs)
      : null;

    function settle(fn) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    }

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', (err) => settle(() => reject(err)));
    proc.on('close', code => {
      settle(() => {
        if (code !== 0) reject(new YtdlpError(stderr.trim() || `yt-dlp exited with ${code}`));
        else resolve(stdout.trim());
      });
    });
  });
}

export async function searchYoutube(query, { timeoutMs } = {}) {
  const output = await spawnAsync('yt-dlp', buildYtdlpArgs('--dump-json', '--flat-playlist', `ytsearch5:${query}`), { timeoutMs });
  return parseJsonLines(output, 'youtube search results');
}

export const PLAYLIST_LIMIT = 100;

export function parseJsonLines(output, context = 'yt-dlp output') {
  return output
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new YtdlpError(`${context}: invalid JSON on line ${index + 1}: ${err.message}`);
      }
    });
}

export function parseFirstJsonLine(output, context = 'yt-dlp output') {
  const [first] = parseJsonLines(output, context);
  if (!first) throw new YtdlpError(`${context}: no JSON output`);
  return first;
}

export function isPlaylistUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.has('list');
  } catch {
    return false;
  }
}

function pickThumbnail(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  if (Array.isArray(entry.thumbnails) && entry.thumbnails.length) {
    return entry.thumbnails[entry.thumbnails.length - 1].url ?? null;
  }
  return null;
}

function toWatchUrl(entry) {
  const raw = entry.url ?? entry.webpage_url;
  if (raw && /^https?:\/\//.test(raw)) return raw;
  if (entry.id) return `https://www.youtube.com/watch?v=${entry.id}`;
  return raw ?? null;
}

// Shared mapping for --flat-playlist entries (resolveFlatPlaylist,
// resolveRelated), whose fields are less normalized than full --dump-json
// metadata and so need toWatchUrl/pickThumbnail's extra fallbacks. Not used
// by resolveMetadata: full metadata reliably has webpage_url/thumbnail
// already, and its top-level `url` field is the resolved media stream URL,
// not a watch-page URL — running it through toWatchUrl would pick that up
// by mistake.
export function mapEntryToTrack(entry, { requestedBy, requestedById = null } = {}) {
  return createTrack({
    title: entry.title ?? 'Unknown',
    webpageUrl: toWatchUrl(entry),
    duration: entry.duration ?? null,
    requestedBy,
    requestedById,
    thumbnail: pickThumbnail(entry),
    videoId: entry.id ?? null,
    channel: entry.channel ?? entry.uploader ?? null,
  });
}

export async function resolveFlatPlaylist(url, { requestedBy, requestedById = null, limit = PLAYLIST_LIMIT } = {}) {
  const output = await spawnAsync('yt-dlp', buildYtdlpArgs(
    '--dump-json',
    '--flat-playlist',
    '--playlist-end', String(limit + 1),
    url,
  ));
  const entries = parseJsonLines(output, 'playlist entries');
  const truncated = entries.length > limit;
  const tracks = entries.slice(0, limit).map(entry => mapEntryToTrack(entry, { requestedBy, requestedById }));
  return { tracks, truncated };
}

export async function resolveMetadata(url, { requestedBy, requestedById = null }) {
  const output = await spawnAsync('yt-dlp', buildYtdlpArgs('--dump-json', '--no-playlist', url));
  const info = parseFirstJsonLine(output, 'video metadata');
  return createTrack({
    title: info.title ?? 'Unknown',
    webpageUrl: info.webpage_url ?? url,
    duration: info.duration ?? null,
    requestedBy,
    requestedById,
    thumbnail: info.thumbnail ?? null,
    videoId: info.id ?? null,
    channel: info.channel ?? info.uploader ?? null,
  });
}

export async function resolveRelated(videoId, { limit = 10 } = {}) {
  const output = await spawnAsync('yt-dlp', buildYtdlpArgs(
    '--dump-json',
    '--flat-playlist',
    '--playlist-end', String(limit + 1),
    `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`,
  ));
  const entries = parseJsonLines(output, 'related videos');
  return entries.slice(0, limit).map(entry => mapEntryToTrack(entry, { requestedBy: '🔀 自動再生', requestedById: null }));
}

export function resolveAudioStream(url) {
  const proc = spawn('yt-dlp', buildYtdlpArgs(
    '-f', YTDLP_AUDIO_FORMAT,
    '--hls-use-mpegts',
    '--no-playlist',
    '-o', '-',
    url,
  ));
  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d; });
  proc.on('error', err => {
    proc.stdout.destroy(err);
  });
  proc.on('close', code => {
    if (code !== 0) {
      proc.stdout.destroy(new YtdlpError(stderrBuf.trim() || `yt-dlp exited ${code}`));
    }
  });
  return proc.stdout;
}
