import { spawn } from 'node:child_process'
import { rm, mkdir, rename, access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildYtdlpArgs, YTDLP_AUDIO_FORMAT } from './search.js'
import {
  SILENCE_TRIM_THRESHOLD_DB,
  SILENCE_TRIM_KEEP_SEC,
  SILENCE_DETECT_MIN_SEC,
  parseSilenceDetectLog,
  resolveEdgeTrimWindow,
  buildAtrimFilter,
} from './audio/silenceTrim.js'
import { probeDurationSec } from './audio/duration.js'

export const MAX_NORMALIZE_DURATION_SEC = 1800
export const TEMP_DIR = path.join(os.tmpdir(), 'music-bot-normalize')
/** Reject silence-trim results shorter than this (likely wiped the whole track). */
export const MIN_TRIMMED_DURATION_SEC = 1

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
  const duration = track?.duration
  // Unknown duration (live / missing metadata) must not take the full-file
  // prefetch path — yt-dlp -o <file> would wait until EOF.
  return Number.isFinite(duration) && duration <= MAX_NORMALIZE_DURATION_SEC
}

export const canNormalizeTrack = isNormalizeDurationAllowed

export async function downloadAudio(url, destPath) {
  await mkdir(path.dirname(destPath), { recursive: true })
  await spawnBuffered('yt-dlp', buildYtdlpArgs(
    '-f', YTDLP_AUDIO_FORMAT,
    '--no-playlist',
    '-o', destPath,
    url,
  ))
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

/**
 * Trim leading/trailing silence in-place (rewrite via temp file).
 * Uses silencedetect + atrim so mid-track pauses stay and RAM stays bounded
 * (no areverse whole-clip buffer).
 * Fail-soft: on error or over-aggressive trim, leave the original file untouched.
 * @returns {Promise<boolean>} true when the file was rewritten
 */
export async function trimSilence(filePath, {
  thresholdDb = SILENCE_TRIM_THRESHOLD_DB,
  keepSec = SILENCE_TRIM_KEEP_SEC,
  detectMinSec = SILENCE_DETECT_MIN_SEC,
  spawnFn = spawnBuffered,
  probeDurationFn = probeDurationSec,
  minDurationSec = MIN_TRIMMED_DURATION_SEC,
} = {}) {
  if (!filePath) return false
  const outPath = `${filePath}.silence-trim`
  const backupPath = `${filePath}.pre-silence-trim`
  try {
    const beforeSec = await probeDurationFn(filePath).catch(() => null)
    if (beforeSec == null) {
      throw new NormalizeError('source duration unknown; skipping silence trim')
    }
    // Move instead of copy: same rollback guarantee without duplicating the file.
    await rename(filePath, backupPath)

    const detect = await spawnFn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'info',
      '-i', backupPath,
      '-af', `silencedetect=noise=${thresholdDb}dB:d=${detectMinSec}`,
      '-f', 'null',
      '-',
    ])
    const { starts, ends } = parseSilenceDetectLog(detect.stderr)
    const window = resolveEdgeTrimWindow({
      durationSec: beforeSec,
      silenceStarts: starts,
      silenceEnds: ends,
      keepSec,
    })
    if (!window.changed) {
      await rename(backupPath, filePath)
      return false
    }

    await spawnFn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', backupPath,
      '-af', buildAtrimFilter(window),
      // Re-encode: filters cannot stream-copy. Opus keeps temp size reasonable.
      '-c:a', 'libopus',
      '-b:a', '160k',
      '-f', 'opus',
      outPath,
    ])
    await access(outPath)
    const afterSec = await probeDurationFn(outPath).catch(() => null)
    if (afterSec == null || afterSec < minDurationSec) {
      throw new NormalizeError(
        `silence trim produced unusable duration (${afterSec ?? 'unknown'}s)`,
      )
    }
    // Guard against wiping nearly the whole track (e.g. very quiet masters).
    if (afterSec < beforeSec * 0.2) {
      throw new NormalizeError(
        `silence trim too aggressive (${beforeSec.toFixed(1)}s -> ${afterSec.toFixed(1)}s)`,
      )
    }
    await rename(outPath, filePath)
    await cleanupTempFile(backupPath)
    return true
  } catch (err) {
    await cleanupTempFile(outPath)
    try {
      await access(backupPath)
      await rename(backupPath, filePath)
    } catch {
      await cleanupTempFile(backupPath)
    }
    console.warn(`[normalize] silence trim skipped: ${err.message}`)
    return false
  }
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
    // Trim YouTube/source padding before loudnorm + MIX analysis so
    // remainingSec and crossfade sit on audible audio.
    await trimSilence(filePath)
    const measured = await analyzeLoudness(filePath)
    return { filePath, measured }
  } catch (err) {
    await cleanupTempFile(filePath)
    await cleanupTempFile(`${filePath}.part`)
    await cleanupTempFile(`${filePath}.silence-trim`)
    await cleanupTempFile(`${filePath}.pre-silence-trim`)
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
