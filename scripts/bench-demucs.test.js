import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findOtherDemucs, parseArgs, planRuns, renderMarkdown, summarizeRun } from './bench-demucs.mjs'

test('parseArgs: defaults mirror the bot (nice 15) and need a source', () => {
  const opts = parseArgs(['--video', 'abc123'])
  assert.equal(opts.video, 'abc123')
  assert.deepEqual(opts.threads, [1, 2, 4])
  assert.deepEqual(opts.models, ['htdemucs'])
  assert.deepEqual(opts.clipSec, [0, 90])
  assert.equal(opts.nice, 15)
  assert.throws(() => parseArgs([]), /--video/)
})

test('parseArgs: parses lists and rejects bad values', () => {
  const opts = parseArgs(['--input', 'a.wav', '--threads', '2,8', '--models', 'htdemucs,mdx_extra_q', '--clip-sec', '0', '--nice', '0', '--label', 'idle'])
  assert.deepEqual(opts.threads, [2, 8])
  assert.deepEqual(opts.models, ['htdemucs', 'mdx_extra_q'])
  assert.deepEqual(opts.clipSec, [0])
  assert.equal(opts.nice, 0)
  assert.equal(opts.label, 'idle')
  assert.throws(() => parseArgs(['--video', 'x', '--threads', '0']), /threads/)
  assert.throws(() => parseArgs(['--video', 'x', '--clip-sec', '-1']), /clip-sec/)
  assert.throws(() => parseArgs(['--video']), /needs a value/)
  assert.throws(() => parseArgs(['--video', 'x', '--bogus']), /unknown option/)
})

test('planRuns: caps threads at available CPUs, dedupes, and runs clips before the full track', () => {
  const runs = planRuns({ threads: [1, 2, 4, 16], models: ['htdemucs'], clipSec: [0, 90] }, 4)
  assert.deepEqual(runs.map((r) => [r.clipSec, r.threads]), [
    [90, 4], [90, 2], [90, 1],
    [0, 4], [0, 2], [0, 1],
  ])
})

test('summarizeRun: RTF and the 600s bot timeout verdict', () => {
  const fast = summarizeRun({ wallSec: 120, audioSec: 240, cpuSec: 480, code: 0, timedOut: false })
  assert.equal(fast.ok, true)
  assert.equal(fast.rtf, 0.5)
  assert.equal(fast.cpuUtil, 4)
  assert.equal(fast.fitsBotTimeout, true)
  assert.equal(fast.fasterThanPlayback, true)

  const slow = summarizeRun({ wallSec: 900, audioSec: 240, cpuSec: 890, code: 0, timedOut: false })
  assert.equal(slow.fitsBotTimeout, false)
  assert.equal(slow.fasterThanPlayback, false)

  const timedOut = summarizeRun({ wallSec: 1800, audioSec: 240, cpuSec: null, code: null, timedOut: true })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.rtf, null)
})

test('renderMarkdown: one row per run, stderr only for failures', () => {
  const md = renderMarkdown({
    startedAt: '2026-11-25T00:00:00.000Z',
    label: 'idle',
    nice: 15,
    host: { cpuModel: 'Test CPU', cpuCount: 4, availableParallelism: 4, cgroupCpuMax: 'max 100000', cgroupMemMax: 'max', totalMemGiB: 8, freeMemGiB: 4, loadavg: [0.1, 0.2, 0.3], demucsVersion: '4.0.1', torchVersion: '2.5.0' },
    input: { source: 'video abc', durationSec: 240 },
    runs: [
      { model: 'htdemucs', clipSec: 90, threads: 4, wallSec: 30, rtf: 0.33, cpuUtil: 3.9, peakRssMiB: 1500, fitsBotTimeout: true, fasterThanPlayback: true, ok: true, timedOut: false, code: 0, stderrTail: null, concurrentDemucsPids: [42] },
      { model: 'htdemucs', clipSec: 0, threads: 1, wallSec: 1800, rtf: null, cpuUtil: null, peakRssMiB: 2000, fitsBotTimeout: false, fasterThanPlayback: false, ok: false, timedOut: true, code: null, stderrTail: 'killed' },
    ],
  })
  assert.match(md, /Demucs ベンチマーク（idle）/)
  assert.match(md, /\| htdemucs \| 末尾 90 秒 \| 4 \| 30\.0 \| 0\.33 \|/)
  assert.match(md, /\| htdemucs \| 曲全体 \| 1 \| 1800\.0 \| - \|.*タイムアウト/)
  assert.match(md, /killed/)
  assert.match(md, /\| ○ \| ○ \| あり \| OK \|/)
  assert.match(md, /\| なし \| タイムアウト \|/)
})

test('findOtherDemucs: spots demucs by argv basename, skips excluded pids and non-pid entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bench-proc-'))
  try {
    const proc = async (pid, argv) => {
      await mkdir(path.join(root, String(pid)))
      await writeFile(path.join(root, String(pid), 'cmdline'), argv.join('\0') + '\0')
    }
    await proc(10, ['nice', '-n', '15', '/opt/demucs-venv/bin/demucs', '--two-stems=vocals'])
    await proc(11, ['/usr/bin/python3', '-m', 'demucs.separate', 'x.wav'])
    await proc(12, ['node', 'src/discord/main.js'])
    await proc(13, ['/opt/demucs-venv/bin/demucs'])
    await mkdir(path.join(root, 'self'))
    const found = await findOtherDemucs({ procRoot: root, excludePids: new Set([13]) })
    assert.deepEqual(found.sort((a, b) => a - b), [10, 11])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
