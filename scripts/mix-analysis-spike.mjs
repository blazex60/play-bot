/**
 * Phase 1.5 analysis spike runner.
 * Downloads public sample tracks and measures vocal/BPM/key/ffmpeg-path options.
 *
 * Usage: node scripts/mix-analysis-spike.mjs
 * Artifacts: tmp/mix-spike/ (gitignored)
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile, access, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'tmp', 'mix-spike')
const RESULTS_JSON = path.join(OUT_DIR, 'results.json')

// Public CC / royalty-free samples (direct HTTP — YouTube is bot-blocked in this env).
// Audio stays in tmp/mix-spike and is NOT committed.
const SAMPLES = [
  {
    id: 'vocal-indie-1',
    label: 'Indie vocal CC (I Find Myself)',
    url: 'https://archive.org/download/ifindmyself/ifindmyself.mp3',
    expect: { hasVocals: true, structure: 'pop-vocal' },
  },
  {
    id: 'vocal-indie-2',
    label: 'Indie vocal CC (What She Knows)',
    url: 'https://archive.org/download/whatsheknows/whatsheknows.mp3',
    expect: { hasVocals: true, structure: 'pop-vocal' },
  },
  {
    id: 'vocal-classical-1',
    label: 'Classical female vocal (Dvořák Biblical Songs)',
    url: 'https://upload.wikimedia.org/wikipedia/commons/8/87/Ten_Biblical_Songs_by_Antonin_Dvorak.ogg',
    expect: { hasVocals: true, structure: 'classical-vocal' },
  },
  {
    id: 'instrumental-carefree',
    label: 'Kevin MacLeod Carefree (instrumental CC)',
    url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3',
    expect: { hasVocals: false, structure: 'instrumental' },
  },
  {
    id: 'instrumental-wallpaper',
    label: 'Kevin MacLeod Wallpaper (instrumental CC)',
    url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/Wallpaper.mp3',
    expect: { hasVocals: false, structure: 'instrumental' },
  },
  {
    id: 'synth-center-vocal',
    label: 'Synthetic mid-band “vocal” vs sides (control)',
    url: 'synthetic:center-vocal',
    expect: { hasVocals: true, structure: 'synthetic' },
  },
  {
    id: 'synth-side-only',
    label: 'Synthetic side-heavy no-center (control)',
    url: 'synthetic:side-only',
    expect: { hasVocals: false, structure: 'synthetic' },
  },
]

function spawnCapture(cmd, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function downloadSample(sample) {
  const existing = (await readdir(OUT_DIR)).find((f) => f.startsWith(`${sample.id}.`) && !f.endsWith('.json') && !f.includes('.spike.'))
  if (existing) {
    return path.join(OUT_DIR, existing)
  }

  if (sample.url.startsWith('synthetic:')) {
    const dest = path.join(OUT_DIR, `${sample.id}.wav`)
    await createSynthetic(sample.url.slice('synthetic:'.length), dest)
    return dest
  }

  if (/^https?:\/\//.test(sample.url)) {
    const ext = path.extname(new URL(sample.url).pathname) || '.mp3'
    const dest = path.join(OUT_DIR, `${sample.id}${ext}`)
    const { code, stderr } = await spawnCapture('curl', [
      '-fsSL', '-A', 'Mozilla/5.0', '-o', dest, sample.url,
    ], { timeoutMs: 300_000 })
    if (code !== 0) throw new Error(`curl failed for ${sample.id}: ${stderr.slice(-400)}`)
    return dest
  }

  const dest = path.join(OUT_DIR, `${sample.id}.%(ext)s`)
  const { code, stderr } = await spawnCapture('yt-dlp', [
    '--js-runtimes', 'node',
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--match-filter', 'duration<600',
    '-x', '--audio-format', 'm4a',
    '-o', dest,
    sample.url,
  ], { timeoutMs: 240_000 })

  if (code !== 0) {
    throw new Error(`yt-dlp failed for ${sample.id}: ${stderr.slice(-500)}`)
  }

  const file = (await readdir(OUT_DIR)).find((f) => f.startsWith(`${sample.id}.`))
  if (!file) throw new Error(`download missing for ${sample.id}`)
  return path.join(OUT_DIR, file)
}

async function createSynthetic(kind, dest) {
  // Mid-centered 1kHz tone ≈ “vocal”; side-only noise ≈ instrumental beds.
  if (kind === 'center-vocal') {
    const { code, stderr } = await spawnCapture('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=20',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=20:amplitude=0.2',
      '-filter_complex',
      '[0]pan=stereo|c0=c0|c1=c0[voc];' +
      '[1]pan=stereo|c0=c0|c1=-1*c0[noise];' +
      '[voc][noise]amix=inputs=2:weights=1 0.35[out]',
      '-map', '[out]', dest,
    ])
    if (code !== 0) throw new Error(`synthetic center-vocal failed: ${stderr.slice(-300)}`)
    return
  }
  if (kind === 'side-only') {
    const { code, stderr } = await spawnCapture('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=20:amplitude=0.4',
      '-af', 'pan=stereo|c0=c0|c1=-1*c0',
      dest,
    ])
    if (code !== 0) throw new Error(`synthetic side-only failed: ${stderr.slice(-300)}`)
    return
  }
  throw new Error(`unknown synthetic kind: ${kind}`)
}

async function probeDuration(filePath) {
  const { stdout } = await spawnCapture('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ])
  return Number(stdout.trim())
}

/** Mid/side center energy in 200Hz–4kHz vs side energy — crude vocal proxy. */
async function analyzeCenterVocal(filePath, { windowSec = 30 } = {}) {
  const duration = await probeDuration(filePath)
  if (!Number.isFinite(duration) || duration <= 0) {
    return { method: 'center-ms-band', ok: false, elapsedMs: 0, note: 'invalid duration' }
  }
  const take = Math.min(windowSec, Math.max(1, duration))
  const start = Math.max(0, duration / 2 - take / 2)

  async function bandRms(panExpr) {
    const { stderr, code } = await spawnCapture('ffmpeg', [
      '-hide_banner', '-nostats',
      '-ss', String(start),
      '-t', String(take),
      '-i', filePath,
      '-af',
      `${panExpr},highpass=f=200,lowpass=f=4000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`,
      '-f', 'null', '-',
    ], { timeoutMs: 120_000 })
    const levels = [...stderr.matchAll(/RMS_level=([-0-9.inf]+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n))
    if (!levels.length) return { code, rms: null }
    levels.sort((a, b) => a - b)
    const rms = levels[Math.floor(levels.length / 2)]
    return { code, rms, samples: levels.length }
  }

  const t0 = Date.now()
  const mid = await bandRms('pan=mono|c0=0.5*c0+0.5*c1')
  const side = await bandRms('pan=mono|c0=0.5*c0-0.5*c1')
  const elapsedMs = Date.now() - t0
  const centerBiasDb = (mid.rms != null && side.rms != null) ? mid.rms - side.rms : null

  return {
    method: 'center-ms-band',
    ok: mid.code === 0 && side.code === 0 && centerBiasDb != null,
    elapsedMs,
    midRms: mid.rms,
    sideRms: side.rms,
    centerBiasDb,
    vocalLikely: centerBiasDb != null ? centerBiasDb > 3 : null,
    notes: 'Positive centerBiasDb means mid louder than side in 200Hz–4kHz. Threshold 3dB is provisional.',
  }
}

/** Tail RMS envelope via astats reset every 0.1s on last 30s. */
async function analyzeTailEnvelope(filePath) {
  const duration = await probeDuration(filePath)
  const tail = Math.min(30, Math.max(5, duration * 0.25))
  const start = Math.max(0, duration - tail)
  const t0 = Date.now()
  const { stderr, code } = await spawnCapture('ffmpeg', [
    '-hide_banner', '-nostats',
    '-ss', String(start),
    '-i', filePath,
    '-af', 'astats=metadata=1:reset=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
    '-f', 'null', '-',
  ], { timeoutMs: 120_000 })
  const elapsedMs = Date.now() - t0
  const levels = [...stderr.matchAll(/RMS_level=([-0-9.]+)/g)].map((m) => Number(m[1]))
  const silences = [...stderr.matchAll(/silence_(start|end):\s*([-0-9.]+)/g)]

  let shape = 'unknown'
  if (levels.length >= 5) {
    const head = average(levels.slice(0, Math.floor(levels.length * 0.3)))
    const end = average(levels.slice(-Math.floor(levels.length * 0.2)))
    const drop = head - end
    if (end < -45) shape = 'silence-tail'
    else if (drop > 12) shape = 'fade-out'
    else if (Math.abs(drop) < 4) shape = 'abrupt'
    else shape = 'gentle-decay'
  }

  return {
    method: 'astats-tail-100ms',
    ok: code === 0 && levels.length > 0,
    elapsedMs,
    sampleCount: levels.length,
    shape,
    lastRms: levels.at(-1) ?? null,
    silenceHints: silences.length,
  }
}

/** Combined loudnorm + silencedetect + astats in one ffmpeg invocation. */
async function analyzeCombinedPass(filePath) {
  const duration = await probeDuration(filePath)
  const start = Math.max(0, duration - 30)
  const t0 = Date.now()
  const { stderr, code } = await spawnCapture('ffmpeg', [
    '-hide_banner', '-nostats',
    '-ss', String(start),
    '-i', filePath,
    '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json,' +
    'silencedetect=noise=-40dB:d=0.3,' +
    'astats=metadata=1:reset=0.1',
    '-f', 'null', '-',
  ], { timeoutMs: 180_000 })
  const elapsedMs = Date.now() - t0

  const hasLoudnormJson = stderr.includes('"input_i"') || stderr.includes('measured_I') || stderr.includes('"input_i"') || /input_i/.test(stderr)
  const silenceCount = (stderr.match(/silence_start/g) || []).length
  const rmsCount = (stderr.match(/RMS level dB/g) || []).length

  // loudnorm print_format=json often appears as a JSON block at end of stderr
  const jsonMatch = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)
  let loudnorm = null
  if (jsonMatch) {
    try { loudnorm = JSON.parse(jsonMatch[0]) } catch { /* ignore */ }
  }

  return {
    method: 'combined-loudnorm-silence-astats',
    ok: code === 0,
    elapsedMs,
    hasLoudnormJson: Boolean(loudnorm) || hasLoudnormJson,
    loudnormKeys: loudnorm ? Object.keys(loudnorm) : [],
    silenceCount,
    rmsEventCount: rmsCount,
    note: loudnorm
      ? 'loudnorm JSON parsed from same pass'
      : 'loudnorm JSON may be truncated when chained; verify separately if missing',
  }
}

async function tryAubioBpm(filePath) {
  // Prefer aubiotrack (C CLI). The python `aubio` wrapper may break on NumPy 2.
  const probe = await spawnCapture('bash', ['-lc', 'command -v aubiotrack || true'])
  if (!probe.stdout.trim()) {
    return { method: 'aubio', available: false, note: 'aubiotrack not installed' }
  }
  const t0 = Date.now()
  const wavPath = `${filePath}.spike.wav`
  await spawnCapture('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-t', '60', '-i', filePath,
    '-ac', '1', '-ar', '44100', wavPath,
  ])
  const { stdout, stderr, code } = await spawnCapture('aubiotrack', ['-i', wavPath], { timeoutMs: 120_000 })
  const beats = stdout.trim().split('\n').map(Number).filter((n) => Number.isFinite(n))
  let bpm = null
  if (beats.length >= 4) {
    const intervals = []
    for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1])
    const median = intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
    if (median > 0) bpm = 60 / median
  }
  return {
    method: 'aubiotrack',
    available: true,
    ok: code === 0 && bpm != null,
    elapsedMs: Date.now() - t0,
    beatCount: beats.length,
    bpm: bpm ? Number(bpm.toFixed(2)) : null,
    stderr: stderr.trim().slice(0, 200),
  }
}

async function analyzeKeyChromagram(filePath) {
  // Lightweight chroma-ish proxy: energy per pitch-class via bandpass banks is heavy.
  // For spike, use ffmpeg showcqt / chromagram dump if available; else mark unavailable.
  const t0 = Date.now()
  const { stderr, code } = await spawnCapture('ffmpeg', [
    '-hide_banner', '-nostats',
    '-t', '45',
    '-i', filePath,
    '-af', 'afireqsrc=preset=flat,astats=metadata=1:reset=1',
    '-f', 'null', '-',
  ], { timeoutMs: 60_000 })
  return {
    method: 'key-placeholder',
    ok: code === 0,
    elapsedMs: Date.now() - t0,
    available: false,
    note: 'Dedicated key detection not in ffmpeg alone; essentia.js or aubio pitch deferred to follow-up install.',
    stderrTail: stderr.slice(-120),
  }
}

function average(arr) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

async function analyzeSample(sample) {
  const result = { id: sample.id, label: sample.label, url: sample.url, expect: sample.expect }
  try {
    const filePath = await downloadSample(sample)
    result.filePath = path.relative(ROOT, filePath)
    result.durationSec = await probeDuration(filePath)
    result.centerVocal = await analyzeCenterVocal(filePath)
    result.tail = await analyzeTailEnvelope(filePath)
    result.combinedPass = await analyzeCombinedPass(filePath)
    result.aubio = await tryAubioBpm(filePath)
    result.key = await analyzeKeyChromagram(filePath)
  } catch (err) {
    result.error = err.message
  }
  return result
}

function renderMarkdown(results) {
  const lines = []
  lines.push('# MIX Phase 1.5 — Analysis Spike Results')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Samples')
  lines.push('')
  for (const r of results) {
    lines.push(`### ${r.id} — ${r.label}`)
    lines.push('')
    lines.push(`- URL: ${r.url}`)
    if (r.error) {
      lines.push(`- **ERROR**: ${r.error}`)
      lines.push('')
      continue
    }
    lines.push(`- Duration: ${r.durationSec?.toFixed?.(1) ?? r.durationSec}s`)
    lines.push(`- Expect vocals: ${r.expect?.hasVocals}`)
    lines.push('')
    lines.push('| Check | Result | Time |')
    lines.push('|---|---|---|')
    const cv = r.centerVocal
    lines.push(`| Center vocal bias | bias=${cv?.centerBiasDb?.toFixed?.(2)} dB, vocalLikely=${cv?.vocalLikely} | ${cv?.elapsedMs}ms |`)
    lines.push(`| Tail shape | ${r.tail?.shape} (last RMS ${r.tail?.lastRms}) | ${r.tail?.elapsedMs}ms |`)
    lines.push(`| Combined ffmpeg pass | loudnormJSON=${r.combinedPass?.hasLoudnormJson}, silences=${r.combinedPass?.silenceCount} | ${r.combinedPass?.elapsedMs}ms |`)
    lines.push(`| aubio BPM | available=${r.aubio?.available}, bpm=${r.aubio?.bpm}, beats=${r.aubio?.beatCount} | ${r.aubio?.elapsedMs ?? '-'} |`)
    lines.push(`| Key | ${r.key?.note} | ${r.key?.elapsedMs}ms |`)
    lines.push('')
  }

  lines.push('## Provisional conclusions')
  lines.push('')
  lines.push('Fill after reviewing numbers:')
  lines.push('')
  lines.push('- [ ] Center-channel vocal detection: adopt / reject / needs essentia')
  lines.push('- [ ] BPM library: aubio / essentia.js / defer')
  lines.push('- [ ] ffmpeg combined pass: 1-pass OK / needs 2-pass')
  lines.push('- [ ] Confidence thresholds: TBD')
  lines.push('')
  lines.push('Raw JSON: `tmp/mix-spike/results.json`')
  lines.push('')
  return lines.join('\n')
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const results = []
  for (const sample of SAMPLES) {
    console.error(`[spike] analyzing ${sample.id}...`)
    const r = await analyzeSample(sample)
    results.push(r)
    console.error(`[spike] done ${sample.id}${r.error ? ` ERROR: ${r.error}` : ''}`)
  }
  await writeFile(RESULTS_JSON, JSON.stringify(results, null, 2))
  const md = renderMarkdown(results)
  const mdPath = path.join(ROOT, 'docs', 'mix-analysis-spike.md')
  await writeFile(mdPath, md)
  console.log(md)
  console.error(`[spike] wrote ${mdPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
