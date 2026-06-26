import { spawn } from 'node:child_process';
import { createTrack } from './queue.js';

export class YtdlpError extends Error {}

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
  const output = await spawnAsync('yt-dlp', ['--dump-json', '--flat-playlist', `ytsearch5:${query}`]);
  return output
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

export async function resolveMetadata(url, { requestedBy }) {
  const output = await spawnAsync('yt-dlp', ['--dump-json', url]);
  const info = JSON.parse(output);
  return createTrack({
    title: info.title ?? 'Unknown',
    webpageUrl: info.webpage_url ?? url,
    duration: info.duration ?? null,
    requestedBy,
    thumbnail: info.thumbnail ?? null,
  });
}

export function resolveStreamUrl(url) {
  return spawnAsync('yt-dlp', ['-f', 'bestaudio/best', '--get-url', url]);
}
