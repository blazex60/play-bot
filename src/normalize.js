import { spawn } from 'node:child_process'
import { rm, mkdir, rename, access, copyFile } from 'node:fs/promises'
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

// Codex review (PR #44): accepts an optional spawnFn override so callers
// running inside the analysis queue's pausable lane (see
// analysisQueue.js's spawnNice) can make these subprocesses actually
// pause/kill-able under CPU pressure, instead of always spawning an
// untracked child via the module-level `spawn` regardless of caller.
function spawnBuffered(cmd, args, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(cmd, args)
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

export async function downloadAudio(url, destPath, { spawnFn } = {}) {
  await mkdir(path.dirname(destPath), { recursive: true })
  await spawnBuffered('yt-dlp', buildYtdlpArgs(
    '-f', YTDLP_AUDIO_FORMAT,
    '--no-playlist',
    '-o', destPath,
    url,
  ), spawnFn)
}

export async function analyzeLoudness(filePath, { spawnFn } = {}) {
  const { stderr } = await spawnBuffered('ffmpeg', [
    '-i', filePath,
    '-af', `loudnorm=${LOUDNORM_TARGET}:print_format=json`,
    '-f', 'null',
    '-',
  ], spawnFn)
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
  // Codex review (PR #44, P1): probeDurationFn's ffprobe calls previously
  // always ran via duration.js's own module-level spawn, untracked by the
  // queue's pause/kill machinery even when `spawnFn` above was overridden —
  // an abort mid-probe left that ffprobe process running free, and once it
  // finished, execution carried on into the next spawnFn-using step (the
  // silencedetect ffmpeg call) as if nothing had happened. `probeSpawnFn` is
  // the raw-ChildProcess-returning override (prefetchTrack() passes its own
  // `spawnFn` straight through here — no spawnBuffered() wrapping needed,
  // duration.js's probeDurationSec() does its own buffering), and `signal`
  // is checked immediately after each probe below — and, before the second
  // probe specifically, immediately before it too (see that call site).
  probeSpawnFn,
  signal,
  minDurationSec = MIN_TRIMMED_DURATION_SEC,
} = {}) {
  if (!filePath) return false
  const outPath = `${filePath}.silence-trim`
  const backupPath = `${filePath}.pre-silence-trim`
  try {
    const beforeSec = await probeDurationFn(filePath, { spawnFn: probeSpawnFn }).catch(() => null)
    if (beforeSec == null) {
      throw new NormalizeError('source duration unknown; skipping silence trim')
    }
    throwIfAborted(signal)
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
    // Codex review (PR #44, round 2, P1): an abort landing while the access()
    // above was pending must be caught HERE, before the next probeDurationFn()
    // spawns ffprobe — checking only after that probe (the previous ordering)
    // let an already-aborted signal still launch a subprocess that the
    // analysis queue may register against the NEXT job by the time it exits,
    // continuing to consume resources during exactly the pressure the abort
    // was meant to relieve.
    throwIfAborted(signal)
    const afterSec = await probeDurationFn(outPath, { spawnFn: probeSpawnFn }).catch(() => null)
    throwIfAborted(signal)
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

// Codex review (PR #44, P1): a queue abort (e.g. a mixer underrun killing
// this job) rejects whichever spawnFn-based call is in flight, but
// trimSilence() deliberately swallows its OWN spawn failures (fail-soft —
// "leave the original file untouched" per its own docstring) and returns
// `false` rather than rejecting. Without an explicit check, prefetchTrack()
// would sail on into the NEXT step's spawnFn call even though its own job
// was already killed — and since analysisQueue.js's spawnEpoch guard only
// kills spawns issued BEFORE a newer abort (not a stale continuation's
// brand-new spawn issued AFTER its own abort), that new process would get
// silently registered into whatever job happens to be running next,
// consuming CPU/being paused-or-killed alongside unrelated work indefinitely.
function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error('prefetch aborted')
  err.code = 'ANALYSIS_KILLED'
  throw err
}

export async function prefetchTrack(track, { spawnFn, signal } = {}) {
  if (!isNormalizeDurationAllowed(track)) {
    throw new NormalizeDurationError(`track exceeds ${MAX_NORMALIZE_DURATION_SEC}s normalize limit`)
  }

  const filePath = tempFilePath(track)
  try {
    await downloadAudio(track.webpageUrl, filePath, { spawnFn })
    throwIfAborted(signal)
    // Trim YouTube/source padding before loudnorm + MIX analysis so
    // remainingSec and crossfade sit on audible audio.
    //
    // Codex review (PR #44, P1): trimSilence()'s `spawnFn` contract is
    // DIFFERENT from downloadAudio()/analyzeLoudness()'s — it expects a
    // function that returns a Promise<{stdout, stderr}> (buffered output),
    // matching spawnBuffered()'s own shape, because trimSilence() reads
    // `detect.stderr` as an already-collected string. `spawnFn` here (e.g.
    // analysisQueue.js's spawnNice) instead returns a raw ChildProcess
    // synchronously — passing it straight through made `detect.stderr` a
    // stream object, not text, so silencedetect's log was never actually
    // parsed and every LOW-priority-prefetched track silently skipped
    // trimming (stems would be built from untrimmed audio, offset from
    // what normal playback/analysis uses). Wrap it in the same
    // spawnBuffered() adapter downloadAudio()/analyzeLoudness() already use
    // internally, so trimSilence() sees the buffered shape it expects.
    // Codex review (PR #44, P1, round 2): probeSpawnFn/signal thread
    // trimSilence()'s duration probes onto this same tracked spawnFn/abort
    // signal too — probeDurationSec()'s own contract is a RAW
    // ChildProcess-returning spawn (it does its own buffering internally
    // via spawnCapture()), unlike the buffered wrapper above, so `spawnFn`
    // (not the wrapped closure) is passed straight through.
    await trimSilence(filePath, spawnFn
      ? { spawnFn: (cmd, args) => spawnBuffered(cmd, args, spawnFn), probeSpawnFn: spawnFn, signal }
      : undefined)
    // trimSilence() is fail-soft (catches its own spawn failures and
    // returns `false`) — check explicitly rather than relying on it to
    // have thrown, or an abort mid-trim would go unnoticed here.
    throwIfAborted(signal)
    const measured = await analyzeLoudness(filePath, { spawnFn })
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

/**
 * Copy filePath to a new, independently-owned temp path under TEMP_DIR.
 * Phase 8 (Codex, PR #39): a track's normalize temp file can be deleted at
 * any time by unrelated cleanup (track promotion/stop/skip/prefetch
 * discard) while a queued job that also needs it (stem separation) is
 * still waiting its turn on the shared analysisQueue, or still running a
 * many-minute Demucs pass. Staging an independent copy immediately, before
 * that wait/run window opens, keeps the caller's own exposure to just this
 * copy's fast local I/O instead of however long the queue takes.
 */
export async function stageTempFileCopy(filePath) {
  const staged = path.join(TEMP_DIR, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}-stage`)
  await copyFile(filePath, staged)
  return staged
}

export async function cleanupStaleTempDir() {
  await rm(TEMP_DIR, { recursive: true, force: true })
  await mkdir(TEMP_DIR, { recursive: true })
}
