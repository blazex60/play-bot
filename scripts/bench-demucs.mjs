#!/usr/bin/env node
/**
 * Demucs benchmark for stem separation (plan: .omc/plans/stem-separation-fix.md, Phase 0).
 *
 * Measures how long two-stem Demucs takes on the host that actually runs the
 * bot, across thread counts / models / full-track vs. transition-clip input,
 * so the stem-separation timeout and thread defaults can come from numbers
 * instead of guesses (production logs: 409/409 separations timed out at 600s).
 *
 * Run it INSIDE the production music-bot container (same Demucs venv, model
 * cache, CPU limits and nice level as the bot):
 *
 *   docker compose cp scripts/bench-demucs.mjs music-bot:/app/bench-demucs.mjs
 *   docker compose exec music-bot node /app/bench-demucs.mjs --video <videoId>
 *
 * Copy the printed Markdown (or the JSON file it names) back. Nothing is
 * uploaded anywhere; temp audio is deleted at the end unless --keep.
 *
 * Options:
 *   --video <id|url>      YouTube video to download with the bot's yt-dlp settings
 *   --input <file>        use a local audio file instead of --video
 *   --threads 1,2,4       OMP/MKL thread counts to try (capped at available CPUs)
 *   --models htdemucs     comma-separated Demucs models (e.g. htdemucs,mdx_extra_q)
 *   --clip-sec 0,90       0 = full track; N = only the last N seconds (transition window)
 *   --nice 15             nice level (15 = what the bot uses; 0 = no nice)
 *   --device cpu          Demucs device: cpu or cuda
 *   --timeout-sec 1800    per-run hard limit
 *   --label <text>        free-form tag, e.g. "idle" or "while-playing"
 *   --out <file.json>     where to write the JSON report (default: /tmp/bench-demucs-<time>.json)
 *   --keep                keep the temp directory
 *   --dry-run             print the planned runs and host info, run nothing heavy
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BOT_TIMEOUT_SEC = 600; // STEM_SEPARATION_TIMEOUT_MS in src/audio/stemCache.js today

export function parseArgs(argv) {
  const opts = {
    video: null,
    input: null,
    threads: [1, 2, 4],
    models: ['htdemucs'],
    clipSec: [0, 90],
    nice: 15,
    device: 'cpu',
    timeoutSec: 1800,
    label: '',
    out: null,
    keep: false,
    dryRun: false,
  };
  const list = (v, num) => String(v).split(',').map((s) => s.trim()).filter(Boolean).map((s) => (num ? Number(s) : s));
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--video': opts.video = next(); break;
      case '--input': opts.input = next(); break;
      case '--threads': opts.threads = list(next(), true); break;
      case '--models': opts.models = list(next(), false); break;
      case '--clip-sec': opts.clipSec = list(next(), true); break;
      case '--nice': opts.nice = Number(next()); break;
      case '--device': opts.device = next(); break;
      case '--timeout-sec': opts.timeoutSec = Number(next()); break;
      case '--label': opts.label = next(); break;
      case '--out': opts.out = next(); break;
      case '--keep': opts.keep = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  const bad = (xs) => xs.some((x) => !Number.isFinite(x) || x < 0);
  if (bad(opts.threads) || opts.threads.includes(0)) throw new Error('--threads must be positive integers');
  if (bad(opts.clipSec)) throw new Error('--clip-sec must be >= 0');
  if (!Number.isFinite(opts.nice)) throw new Error('--nice must be a number');
  if (!['cpu', 'cuda'].includes(opts.device)) throw new Error('--device must be cpu or cuda');
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0) throw new Error('--timeout-sec must be > 0');
  if (!opts.help && !opts.video && !opts.input) throw new Error('give --video <id|url> or --input <file>');
  return opts;
}

/** Runs are ordered cheapest-first so a slow host still yields useful rows early. */
export function planRuns({ threads, models, clipSec }, cpuCount) {
  const usableThreads = [...new Set(threads.map((t) => Math.min(t, cpuCount)))].sort((a, b) => a - b);
  const clips = [...new Set(clipSec)].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const runs = [];
  for (const clip of clips) {
    for (const model of models) {
      for (const t of [...usableThreads].reverse()) runs.push({ model, threads: t, clipSec: clip });
    }
  }
  return runs;
}

/** RTF = wall seconds / audio seconds. < 1 means faster than real time. */
export function summarizeRun({ wallSec, audioSec, cpuSec, code, timedOut }) {
  const ok = code === 0 && !timedOut;
  const rtf = ok && audioSec > 0 ? wallSec / audioSec : null;
  return {
    ok,
    rtf,
    cpuUtil: ok && wallSec > 0 && cpuSec != null ? cpuSec / wallSec : null,
    fitsBotTimeout: ok ? wallSec <= BOT_TIMEOUT_SEC : false,
    // A next-track (B) prefetch gets roughly one track's play time to finish.
    fasterThanPlayback: rtf != null ? rtf < 1 : false,
  };
}

function fmt(n, digits = 2) {
  return n == null || !Number.isFinite(n) ? '-' : n.toFixed(digits);
}

export function renderMarkdown(report) {
  const h = report.host;
  const lines = [];
  lines.push(`## Demucs ベンチマーク${report.label ? `（${report.label}）` : ''}`);
  lines.push('');
  lines.push(`- 実行日時: ${report.startedAt}`);
  lines.push(`- CPU: ${h.cpuModel} / 論理 ${h.cpuCount}（Node から使える数 ${h.availableParallelism}）`);
  lines.push(`- cgroup CPU 制限: ${h.cgroupCpuMax ?? '不明'} / メモリ制限: ${h.cgroupMemMax ?? '不明'}`);
  lines.push(`- メモリ: 合計 ${fmt(h.totalMemGiB, 1)} GiB / 空き ${fmt(h.freeMemGiB, 1)} GiB、loadavg ${h.loadavg.map((x) => fmt(x)).join(' ')}`);
  lines.push(`- Demucs: ${h.demucsVersion ?? '不明'} / torch: ${h.torchVersion ?? '不明'}`);
  lines.push(`- 入力: ${report.input.source}（${fmt(report.input.durationSec, 1)} 秒）、nice ${report.nice}、デバイス ${report.device ?? 'cpu'}`);
  lines.push('');
  lines.push('| モデル | 区間 | スレッド | 所要(秒) | RTF | CPU 使用率 | ピーク RSS(MiB) | 600秒以内 | 再生より速い | 並行 Demucs | 結果 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of report.runs) {
    const clip = r.clipSec === 0 ? '曲全体' : `末尾 ${r.clipSec} 秒`;
    const result = r.ok ? 'OK' : r.timedOut ? 'タイムアウト' : `失敗 (exit ${r.code})`;
    lines.push(`| ${r.model} | ${clip} | ${r.threads} | ${fmt(r.wallSec, 1)} | ${fmt(r.rtf)} | ${fmt(r.cpuUtil)} | ${fmt(r.peakRssMiB, 0)} | ${r.fitsBotTimeout ? '○' : '×'} | ${r.fasterThanPlayback ? '○' : '×'} | ${r.concurrentDemucsPids?.length ? 'あり' : 'なし'} | ${result} |`);
  }
  const failed = report.runs.filter((r) => !r.ok && r.stderrTail);
  if (failed.length > 0) {
    lines.push('');
    lines.push('<details><summary>失敗したランの stderr 末尾</summary>');
    lines.push('');
    for (const r of failed) {
      lines.push(`**${r.model} / ${r.clipSec === 0 ? '曲全体' : `末尾 ${r.clipSec} 秒`} / ${r.threads} スレッド**`);
      lines.push('```');
      lines.push(r.stderrTail);
      lines.push('```');
    }
    lines.push('</details>');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- runtime

function run(cmd, args, { env, timeoutMs, onSpawn } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let proc;
    try {
      proc = spawn(cmd, args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), wallSec: 0, timedOut: false });
      return;
    }
    onSpawn?.(proc);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs)
      : null;
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
    proc.on('error', (err) => { stderr += String(err); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, wallSec: Number(process.hrtime.bigint() - started) / 1e9 });
    });
  });
}

async function readText(file) {
  try { return (await readFile(file, 'utf8')).trim(); } catch { return null; }
}

/** Samples /proc for peak RSS and CPU time of the Demucs process (nice execs into it, same pid). */
function startProcSampler(pid) {
  const ticksPerSec = 100; // USER_HZ on Linux
  const state = { peakRssKiB: 0, cpuSec: null };
  const sample = async () => {
    const status = await readText(`/proc/${pid}/status`);
    const hwm = status?.match(/^VmHWM:\s+(\d+)\s+kB/m);
    if (hwm) state.peakRssKiB = Math.max(state.peakRssKiB, Number(hwm[1]));
    const stat = await readText(`/proc/${pid}/stat`);
    if (stat) {
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      // utime, stime, cutime, cstime — waited-for children count too, in case
      // a Demucs build forks helpers instead of using threads.
      const ticks = fields.slice(11, 15).map(Number);
      if (ticks.every(Number.isFinite)) state.cpuSec = ticks.reduce((a, b) => a + b, 0) / ticksPerSec;
    }
  };
  const timer = setInterval(() => { sample().catch(() => {}); }, 500);
  return { state, stop: () => clearInterval(timer) };
}

/** pids of Demucs processes other than our own runs (the bot's own stem jobs skew results). */
export async function findOtherDemucs({ procRoot = '/proc', excludePids = new Set() } = {}) {
  const { readdir } = await import('node:fs/promises');
  let entries;
  try { entries = await readdir(procRoot); } catch { return []; }
  const found = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name) || excludePids.has(Number(name))) continue;
    const cmdline = await readText(path.join(procRoot, name, 'cmdline'));
    if (!cmdline) continue;
    const argv = cmdline.split('\0').filter(Boolean);
    if (argv.some((a) => path.basename(a) === 'demucs' || a === 'demucs.separate')) found.push(Number(name));
  }
  return found;
}

async function hostInfo() {
  const cpuList = cpus();
  const memMax = await readText('/sys/fs/cgroup/memory.max');
  const versions = await run('python3', ['-c', 'import importlib.metadata as m, json; print(json.dumps({k: m.version(k) for k in ("demucs","torch")}))'], {
    env: { ...process.env, PATH: `${process.env.DEMUCS_VENV ? `${process.env.DEMUCS_VENV}/bin:` : ''}${process.env.PATH}` },
    timeoutMs: 60_000,
  });
  let parsed = {};
  try { parsed = JSON.parse(versions.stdout.trim().split('\n').pop()); } catch { /* not installed */ }
  return {
    cpuModel: cpuList[0]?.model?.trim() ?? 'unknown',
    cpuCount: cpuList.length,
    availableParallelism: availableParallelism(),
    cgroupCpuMax: await readText('/sys/fs/cgroup/cpu.max'),
    cgroupMemMax: memMax && memMax !== 'max' ? `${(Number(memMax) / 2 ** 30).toFixed(1)} GiB` : memMax,
    totalMemGiB: totalmem() / 2 ** 30,
    freeMemGiB: freemem() / 2 ** 30,
    loadavg: loadavg(),
    demucsVersion: parsed.demucs ?? null,
    torchVersion: parsed.torch ?? null,
  };
}

async function ytdlpArgs(...args) {
  // Reuse the bot's own yt-dlp settings (cookies, extractor args). Resolved
  // from this file's location, not cwd: in the repo it lives in scripts/, and
  // the documented container invocation copies it to /app/ next to src/.
  for (const root of [new URL('..', import.meta.url), new URL('.', import.meta.url)]) {
    const searchJs = new URL('src/media/search.js', root);
    try {
      await access(searchJs);
      const mod = await import(searchJs.href);
      return mod.buildYtdlpArgs(...args);
    } catch {
      // try the next candidate
    }
  }
  const cookies = process.env.YTDLP_COOKIES_FILE?.trim();
  return ['--no-cache-dir', ...(cookies ? ['--cookies', cookies] : []), ...args];
}

async function probeDurationSec(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeoutMs: 60_000 });
  const d = Number(r.stdout.trim());
  return Number.isFinite(d) ? d : null;
}

async function prepareSource(opts, workDir) {
  if (opts.input) {
    await access(opts.input);
    return { file: opts.input, source: path.basename(opts.input) };
  }
  const url = /^https?:/.test(opts.video) ? opts.video : `https://www.youtube.com/watch?v=${opts.video}`;
  const out = path.join(workDir, 'source.audio');
  const args = await ytdlpArgs('-f', 'bestaudio[protocol^=http]/bestaudio/best', '--no-playlist', '-o', out, url);
  process.stderr.write('yt-dlp でダウンロード中...\n');
  const r = await run('yt-dlp', args, { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`yt-dlp failed (exit ${r.code}):\n${r.stderr.slice(-2000)}`);
  return { file: out, source: `video ${opts.video}` };
}

async function cutWav(src, dst, clipSec) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (clipSec > 0) args.push('-sseof', `-${clipSec}`);
  args.push('-i', src, '-ac', '2', '-ar', '44100', dst);
  const r = await run('ffmpeg', args, { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-1000)}`);
}

function demucsBin() {
  return process.env.DEMUCS_BIN
    || (process.env.DEMUCS_VENV ? path.join(process.env.DEMUCS_VENV, 'bin', 'demucs') : 'demucs');
}

async function benchOne({ model, threads, clipSec }, { opts, workDir, sourceFile }) {
  const wav = path.join(workDir, `in-${clipSec}.wav`);
  await cutWav(sourceFile, wav, clipSec);
  const audioSec = await probeDurationSec(wav);
  const outDir = path.join(workDir, `out-${model}-${threads}-${clipSec}`);
  const demucsArgs = ['--two-stems=vocals', '-n', model, '-d', opts.device, '-o', outDir, wav];
  const [cmd, args] = opts.nice > 0
    ? ['nice', ['-n', String(opts.nice), demucsBin(), ...demucsArgs]]
    : [demucsBin(), demucsArgs];
  const env = {
    ...process.env,
    OMP_NUM_THREADS: String(threads),
    MKL_NUM_THREADS: String(threads),
    TORCH_HOME: process.env.TORCH_HOME || '/opt/torch-cache',
  };
  let sampler = null;
  const r = await run(cmd, args, {
    env,
    timeoutMs: opts.timeoutSec * 1000,
    onSpawn: (proc) => { if (proc.pid) sampler = startProcSampler(proc.pid); },
  });
  sampler?.stop();
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
  const summary = summarizeRun({ wallSec: r.wallSec, audioSec, cpuSec: sampler?.state.cpuSec ?? null, code: r.code, timedOut: r.timedOut });
  return {
    model,
    threads,
    clipSec,
    audioSec,
    wallSec: r.wallSec,
    code: r.code,
    timedOut: r.timedOut,
    peakRssMiB: sampler ? sampler.state.peakRssKiB / 1024 : null,
    ...summary,
    stderrTail: summary.ok ? null : r.stderr.trim().split('\n').slice(-15).join('\n'),
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n`);
    opts = { help: true, failed: true };
  }
  if (opts.help) {
    const src = await readFile(new URL(import.meta.url), 'utf8');
    process.stderr.write(`${src.match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '')}\n`);
    process.exit(opts.failed ? 2 : 0);
  }

  const host = await hostInfo();
  const busy = await findOtherDemucs();
  if (busy.length > 0) {
    process.stderr.write(`注意: 他の Demucs プロセス（Bot のステム分離）が動いています: pid ${busy.join(', ')}\n`
      + '  結果が遅めに出ます。誰も再生していないときに実行するか、表の「並行」列を見て判断してください。\n');
  }
  const runs = planRuns(opts, host.availableParallelism);
  const startedAt = new Date().toISOString();
  process.stderr.write(`計画: ${runs.length} ラン（${runs.map((r) => `${r.model}/${r.clipSec || 'full'}/${r.threads}t`).join(', ')}）\n`);
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify({ host, runs }, null, 2)}\n`);
    return;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'bench-demucs-'));
  const report = { startedAt, label: opts.label, nice: opts.nice, device: opts.device, host, input: null, runs: [] };
  const outFile = opts.out ?? path.join(tmpdir(), `bench-demucs-${startedAt.replace(/[:.]/g, '-')}.json`);
  try {
    const { file, source } = await prepareSource(opts, workDir);
    report.input = { source, durationSec: await probeDurationSec(file) };
    for (const [i, plan] of runs.entries()) {
      process.stderr.write(`[${i + 1}/${runs.length}] ${plan.model} / ${plan.clipSec === 0 ? '曲全体' : `末尾 ${plan.clipSec} 秒`} / ${plan.threads} スレッド ... `);
      const others = await findOtherDemucs();
      if (others.length > 0) process.stderr.write(`(注意: Bot 側の Demucs が動作中 pid ${others.join(',')}) `);
      const result = await benchOne(plan, { opts, workDir, sourceFile: file });
      result.concurrentDemucsPids = others;
      report.runs.push(result);
      process.stderr.write(result.ok ? `${result.wallSec.toFixed(1)} 秒 (RTF ${result.rtf.toFixed(2)})\n` : (result.timedOut ? 'タイムアウト\n' : `失敗 exit ${result.code}\n`));
      // Save after every run so a long benchmark that gets interrupted still leaves data.
      await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    if (!opts.keep) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    else process.stderr.write(`一時ディレクトリを残しました: ${workDir}\n`);
  }
  process.stdout.write(`${renderMarkdown(report)}\n`);
  process.stderr.write(`\nJSON: ${outFile}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exit(1);
  });
}
