import { spawn } from 'node:child_process';
import { createTrack } from './queue.js';

export class YtdlpError extends Error {}

const YTDLP_JS_RUNTIME_ARGS = ['--js-runtimes', 'node'];

function spawnAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) reject(new YtdlpError(stderr.trim() || `yt-dlp exited with ${code}`));
      else resolve(stdout.trim());
    });
  });
}

export async function searchYoutube(query) {
  const output = await spawnAsync('yt-dlp', [
    ...YTDLP_JS_RUNTIME_ARGS,
    '--dump-json',
    '--flat-playlist',
    `ytsearch5:${query}`,
  ]);
  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

export const PLAYLIST_LIMIT = 100;

export function isPlaylistUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.has('list') && !u.searchParams.has('v');
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

export async function resolveFlatPlaylist(url, { requestedBy, limit = PLAYLIST_LIMIT } = {}) {
  const output = await spawnAsync('yt-dlp', [
    ...YTDLP_JS_RUNTIME_ARGS,
    '--dump-json',
    '--flat-playlist',
    '--playlist-end', String(limit + 1),
    url,
  ]);
  const entries = output.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const truncated = entries.length > limit;
  const tracks = entries.slice(0, limit).map(entry => createTrack({
    title: entry.title ?? 'Unknown',
    webpageUrl: toWatchUrl(entry),
    duration: entry.duration ?? null,
    requestedBy,
    thumbnail: pickThumbnail(entry),
  }));
  return { tracks, truncated };
}

export async function resolveMetadata(url, { requestedBy }) {
  const output = await spawnAsync('yt-dlp', [
    ...YTDLP_JS_RUNTIME_ARGS,
    '--dump-json',
    url,
  ]);
  const info = JSON.parse(output);
  return createTrack({
    title: info.title ?? 'Unknown',
    webpageUrl: info.webpage_url ?? url,
    duration: info.duration ?? null,
    requestedBy,
    thumbnail: info.thumbnail ?? null,
  });
}

export function resolveAudioStream(url) {
  const proc = spawn('yt-dlp', [
    ...YTDLP_JS_RUNTIME_ARGS,
    '-f', 'bestaudio/best',
    '--no-playlist',
    '-o', '-',
    url,
  ]);
  let stderrBuf = '';
  proc.stderr.on('data', d => { stderrBuf += d; });
  proc.on('close', code => {
    if (code !== 0) {
      proc.stdout.destroy(new YtdlpError(stderrBuf.trim() || `yt-dlp exited ${code}`));
    }
  });
  return proc.stdout;
}
