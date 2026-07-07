import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'
import { createAudioResource, StreamType } from '@discordjs/voice'
import os from 'node:os'
import path from 'node:path'

export const MAX_NORMALIZE_DURATION_SEC = 1800
export const TEMP_DIR = path.join(os.tmpdir(), 'music-bot-normalize')

const LOUDNORM_TARGET = 'I=-16:TP=-1.5:LRA=11'

export class NormalizeError extends Error {}
export class NormalizeDurationError extends NormalizeError {}

function spawnBuffered(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', data => { stdout += data })
    proc.stderr.on('data', data => { stderr += data })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) {
        reject(new NormalizeError(stderr.trim() || `${cmd} exited with ${code}`))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

function requireNumber(record, ...keys) {
  for (const key of keys) {
    const raw = record[key]
    if (raw === undefined || raw === null || raw === '') continue
    const value = Number(raw)
    if (Number.isFinite(value)) return String(raw)
  }
  throw new NormalizeError(`loudnorm JSON missing numeric field: ${keys.join('/')}`)
}

export function parseLoudnormJson(stderrText) {
  const end = stderrText.lastIndexOf('}')
  if (end === -1) throw new NormalizeError('loudnorm JSON block not found')

  const start = stderrText.lastIndexOf('{', end)
  if (start === -1) throw new NormalizeError('loudnorm JSON block not found')

  let parsed
  try {
    parsed = JSON.parse(stderrText.slice(start, end + 1))
  } catch (err) {
    throw new NormalizeError(`invalid loudnorm JSON: ${err.message}`)
  }

  return {
    measured_I: requireNumber(parsed, 'measured_I', 'input_i'),
    measured_TP: requireNumber(parsed, 'measured_TP', 'input_tp'),
    measured_LRA: requireNumber(parsed, 'measured_LRA', 'input_lra'),
    measured_thresh: requireNumber(parsed, 'measured_thresh', 'input_thresh'),
    offset: requireNumber(parsed, 'offset', 'target_offset'),
  }
}

export function isNormalizeDurationAllowed(track) {
  return track?.duration == null || track.duration <= MAX_NORMALIZE_DURATION_SEC
}

export const canNormalizeTrack = isNormalizeDurationAllowed

export async function downloadAudio(url, destPath) {
  await mkdir(path.dirname(destPath), { recursive: true })
  await spawnBuffered('yt-dlp', [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '-o', destPath,
    url,
  ])
}

export async function analyzeLoudness(filePath) {
  const { stderr } = await spawnBuffered('ffmpeg', [
    '-i', filePath,
    '-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`,
    '-f', 'null',
    '-',
  ])
  return parseLoudnormJson(stderr)
}

export function createNormalizedResource(filePath, measured) {
  const proc = spawn('ffmpeg', [
    '-i', filePath,
    '-af',
    `loudnorm=${LOUDNORM_TARGET}:measured_I=${measured.measured_I}:measured_TP=${measured.measured_TP}:measured_LRA=${measured.measured_LRA}:measured_thresh=${measured.measured_thresh}:offset=${measured.offset}:linear=true:print_format=summary`,
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  proc.stderr.on('data', data => { stderr += data })
  proc.on('error', err => {
    proc.stdout.destroy(err)
  })
  proc.on('close', code => {
    if (code !== 0) {
      proc.stdout.destroy(new NormalizeError(stderr.trim() || `ffmpeg exited with ${code}`))
    }
  })

  return createAudioResource(proc.stdout, {
    inputType: StreamType.Raw,
  })
}

function tempFilePath(track) {
  const safeTitle = (track?.title ?? 'track').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48)
  return path.join(TEMP_DIR, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}-${safeTitle}`)
}

export async function prefetchTrack(track) {
  if (!isNormalizeDurationAllowed(track)) {
    throw new NormalizeDurationError(`track exceeds ${MAX_NORMALIZE_DURATION_SEC}s normalize limit`)
  }

  const filePath = tempFilePath(track)
  try {
    await downloadAudio(track.webpageUrl, filePath)
    const measured = await analyzeLoudness(filePath)
    return { filePath, measured }
  } catch (err) {
    await cleanupTempFile(filePath)
    await cleanupTempFile(`${filePath}.part`)
    throw err
  }
}

export async function cleanupTempFile(filePath) {
  if (!filePath) return
  await rm(filePath, { force: true })
}

export async function cleanupStaleTempDir() {
  await rm(TEMP_DIR, { recursive: true, force: true })
  await mkdir(TEMP_DIR, { recursive: true })
}
