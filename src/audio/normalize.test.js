import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import {
  MAX_NORMALIZE_DURATION_SEC,
  NormalizeError,
  isNormalizeDurationAllowed,
  parseLoudnormJson,
  stageTempFileCopy,
  cleanupTempFile,
  downloadAudio,
  analyzeLoudness,
  prefetchTrack,
  trimSilence,
  TEMP_DIR,
} from './normalize.js'

/** Mirrors stemCache.test.js's fakeSpawn shape (an EventEmitter-based fake child process). */
function fakeSpawn({ stderr = '', fails = false } = {}) {
  const calls = []
  const spawnFn = (cmd, args = []) => {
    calls.push({ cmd, args })
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    queueMicrotask(() => {
      if (stderr) proc.stderr.emit('data', stderr)
      proc.emit('close', fails ? 1 : 0)
    })
    return proc
  }
  spawnFn.calls = calls
  return spawnFn
}

test('parseLoudnormJson: ffmpeg stderr末尾のJSONをパースする', () => {
  const measured = parseLoudnormJson(`
    ffmpeg version ...
    [Parsed_loudnorm_0 @ 0x123] 
    {
      "input_i" : "-23.45",
      "input_tp" : "-2.34",
      "input_lra" : "9.80",
      "input_thresh" : "-34.56",
      "output_i" : "-16.01",
      "target_offset" : "-0.12"
    }
  `)

  assert.deepEqual(measured, {
    measured_I: '-23.45',
    measured_TP: '-2.34',
    measured_LRA: '9.80',
    measured_thresh: '-34.56',
    offset: '-0.12',
  })
})

test('parseLoudnormJson: measured_*形式も受け付ける', () => {
  const measured = parseLoudnormJson(`
    {"measured_I":"-20","measured_TP":"-1","measured_LRA":"7","measured_thresh":"-30","offset":"0.5"}
  `)

  assert.deepEqual(measured, {
    measured_I: '-20',
    measured_TP: '-1',
    measured_LRA: '7',
    measured_thresh: '-30',
    offset: '0.5',
  })
})

test('parseLoudnormJson: 不正JSONは例外', () => {
  assert.throws(
    () => parseLoudnormJson('ffmpeg log\n{not json}\n'),
    NormalizeError
  )
})

test('parseLoudnormJson: 必須フィールド欠損は例外', () => {
  assert.throws(
    () => parseLoudnormJson('{"input_i":"-16"}'),
    NormalizeError
  )
})

test('isNormalizeDurationAllowed: 尺が分かる30分以下なら許可する', () => {
  assert.equal(isNormalizeDurationAllowed({ duration: MAX_NORMALIZE_DURATION_SEC }), true)
  assert.equal(isNormalizeDurationAllowed({ duration: 1 }), true)
})

test('isNormalizeDurationAllowed: 尺不明や30分超は拒否する', () => {
  assert.equal(isNormalizeDurationAllowed({ duration: null }), false)
  assert.equal(isNormalizeDurationAllowed({}), false)
  assert.equal(isNormalizeDurationAllowed({ duration: Number.NaN }), false)
  assert.equal(isNormalizeDurationAllowed({ duration: Number.POSITIVE_INFINITY }), false)
  assert.equal(isNormalizeDurationAllowed({ duration: MAX_NORMALIZE_DURATION_SEC + 1 }), false)
})

test('stageTempFileCopy: 独立したコピーを作成し、元ファイル削除後も内容が残る（Codex, PR #39）', async () => {
  await mkdir(TEMP_DIR, { recursive: true })
  const original = `${TEMP_DIR}/stage-test-original-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await writeFile(original, 'hello stem separation')
  let staged
  try {
    staged = await stageTempFileCopy(original)
    assert.notEqual(staged, original, 'expected a distinct path, not the original')

    // The whole point: deleting the original must not affect the staged
    // copy — that decoupling is what protects a queued stem-separation job
    // from unrelated cleanup deleting the source file out from under it.
    await cleanupTempFile(original)
    await assert.rejects(() => access(original), 'expected the original to actually be gone')

    const content = await readFile(staged, 'utf8')
    assert.equal(content, 'hello stem separation')
  } finally {
    if (staged) await cleanupTempFile(staged)
    await rm(original, { force: true })
  }
})

// --- Codex review (PR #44, P1): downloadAudio/analyzeLoudness spawnFn threading ---
//
// Without this, prefetchTrack()'s subprocesses always spawn via the
// module-level `spawn`, untracked by analysisQueue's pause/kill machinery —
// a caller running inside the queue (Phase 9B's low-priority stem prefetch)
// couldn't actually pause them under a mixer underrun despite believing it
// could. These verify the override is honored, not real yt-dlp/ffmpeg
// behavior (ffmpeg isn't installed in this sandbox, a known limitation).

test('downloadAudio: honors a custom spawnFn instead of always using node:child_process spawn', async () => {
  const dest = `${TEMP_DIR}/spawnfn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const spawnFn = fakeSpawn()
  try {
    await downloadAudio('https://example.com/watch?v=fake', dest, { spawnFn })
    assert.equal(spawnFn.calls.length, 1)
    assert.equal(spawnFn.calls[0].cmd, 'yt-dlp')
  } finally {
    await rm(dest, { force: true })
  }
})

test('downloadAudio: a spawnFn failure surfaces as a rejection, not a silent success', async () => {
  const dest = `${TEMP_DIR}/spawnfn-test-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const spawnFn = fakeSpawn({ fails: true })
  try {
    await assert.rejects(() => downloadAudio('https://example.com/watch?v=fake', dest, { spawnFn }))
  } finally {
    await rm(dest, { force: true })
  }
})

test('analyzeLoudness: honors a custom spawnFn and parses its stderr', async () => {
  const loudnormJson = JSON.stringify({
    input_i: '-20.0', input_tp: '-2.0', input_lra: '5.0', input_thresh: '-30.0', target_offset: '0.5',
  })
  const spawnFn = fakeSpawn({ stderr: `some ffmpeg preamble\n${loudnormJson}\n` })
  const measured = await analyzeLoudness('/tmp/does-not-need-to-exist.wav', { spawnFn })
  assert.equal(spawnFn.calls.length, 1)
  assert.equal(spawnFn.calls[0].cmd, 'ffmpeg')
  assert.equal(measured.measured_I, '-20.0')
})

test('downloadAudio/analyzeLoudness: default to real node:child_process spawn when no override is given', () => {
  // Not exercised end-to-end (no ffmpeg/yt-dlp in this sandbox) — just
  // confirms the optional-param default doesn't throw synchronously before
  // even attempting to spawn, i.e. existing callers (#ensureFullPrefetch's
  // plain prefetchTrackFn(track) call, with no options object at all)
  // remain unaffected by this signature change.
  assert.doesNotThrow(() => { downloadAudio('https://example.com', '/tmp/unused-dest').catch(() => {}) })
  assert.doesNotThrow(() => { analyzeLoudness('/tmp/unused.wav').catch(() => {}) })
})

test('prefetchTrack: stops before the next spawnFn-using step once signal.aborted is true (Codex review, PR #44, P1)', async () => {
  // trimSilence() is fail-soft (catches its own spawn failures internally,
  // returns `false` rather than rejecting) — without an explicit signal
  // check between steps, an aborted job would sail on into the NEXT step's
  // spawn call even though its own job was already killed. Aborting right
  // after the download succeeds and counting spawnFn calls proves
  // prefetchTrack() stops there instead of proceeding into trimSilence's
  // own spawn.
  let calls = 0
  const signal = { aborted: false }
  const spawnFn = (cmd, args = []) => {
    calls += 1
    signal.aborted = true // simulate the queue killing this job right as the download finishes
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    queueMicrotask(() => proc.emit('close', 0))
    return proc
  }

  const track = { title: 'Track', webpageUrl: 'https://example.com/watch?v=fake', duration: 60 }
  try {
    await assert.rejects(
      () => prefetchTrack(track, { spawnFn, signal }),
      (err) => err.code === 'ANALYSIS_KILLED',
    )
    assert.equal(calls, 1, 'expected only the download\'s spawn call, not a trimSilence spawn after the abort')
  } finally {
    // downloadAudio's mkdir + prefetchTrack's own tempFilePath() naming
    // means we don't know the exact path here — best-effort sweep isn't
    // needed since the file was never actually written (fake spawn never
    // touches disk), only cleanupTempFile()'s own no-op-on-missing-file
    // path would run inside prefetchTrack's catch block already.
  }
})

test('prefetchTrack: routes trimSilence\'s duration probe through the tracked spawnFn, and an abort noticed there stops before the next ffmpeg step (Codex review, PR #44, P1, round 2)', async () => {
  // Previously trimSilence()'s probeDurationFn (duration.js's
  // probeDurationSec) always used duration.js's own module-level spawn,
  // untracked by the queue's pause/kill machinery even though this test's
  // injected spawnFn covers every OTHER subprocess in the pipeline. An
  // abort arriving mid-probe would leave that ffprobe process running free,
  // and once it eventually finished on its own, trimSilence would sail on
  // into the next ffmpeg step as if nothing had happened.
  const calls = []
  const signal = { aborted: false }
  const spawnFn = (cmd, args = []) => {
    calls.push(cmd)
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {}
    queueMicrotask(() => {
      if (cmd === 'ffprobe') {
        proc.stdout.emit('data', '12.5')
        signal.aborted = true // simulate the queue killing this job right as the probe finishes
      }
      proc.emit('close', 0)
    })
    return proc
  }

  const track = { title: 'Track', webpageUrl: 'https://example.com/watch?v=fake', duration: 60 }
  await assert.rejects(
    () => prefetchTrack(track, { spawnFn, signal }),
    (err) => err.code === 'ANALYSIS_KILLED',
  )
  assert.ok(calls.includes('ffprobe'), 'expected the duration probe to run through the tracked spawnFn, not real ffprobe')
  assert.ok(!calls.includes('ffmpeg'),
    'expected trimSilence to stop before its silencedetect ffmpeg spawn once the probe-time abort was noticed')
})

test('trimSilence: an abort noticed right after the re-encode step stops before the final duration probe (Codex review, PR #44, round 3, P1)', async () => {
  // The previous ordering called probeDurationFn(outPath) for the AFTER
  // duration and only checked signal.aborted once that probe had already
  // finished — an abort landing while the preceding access(outPath) was
  // pending still let a brand-new ffprobe spawn start, which the analysis
  // queue could register against the NEXT job by the time it exited.
  await mkdir(TEMP_DIR, { recursive: true })
  const filePath = `${TEMP_DIR}/trim-abort-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await writeFile(filePath, 'original-audio-bytes')

  const signal = { aborted: false }
  const probeCalls = []
  const probeDurationFn = async (path) => {
    probeCalls.push(path)
    return probeCalls.length === 1 ? 60 : 999 // only the BEFORE probe should ever be asked
  }
  const spawnFn = async (cmd, args = []) => {
    if (args.includes('-c:a')) {
      // The re-encode/atrim step: write a real file to outPath (the last
      // arg) so the following access(outPath) succeeds, then simulate the
      // queue aborting this job right as the step finishes.
      await writeFile(args[args.length - 1], 'trimmed-audio-bytes')
      signal.aborted = true
      return { stderr: '' }
    }
    // The silencedetect step: a leading-silence log that makes
    // resolveEdgeTrimWindow() report changed:true, so the pipeline actually
    // proceeds into the re-encode step above instead of returning early.
    return { stderr: 'silence_start: 0.00\nsilence_end: 1.00\n' }
  }

  const result = await trimSilence(filePath, { spawnFn, probeDurationFn, signal })

  assert.equal(result, false, 'trimSilence is fail-soft — an aborted attempt must not throw, and must not report success')
  assert.equal(probeCalls.length, 1,
    `expected the final duration probe to be skipped once the abort was noticed, got ${probeCalls.length} probe call(s)`)
  await access(filePath) // the original file must have been restored from its backup
  const restored = await readFile(filePath, 'utf8')
  assert.equal(restored, 'original-audio-bytes', 'expected the original file to be restored untouched on an aborted attempt')
})
