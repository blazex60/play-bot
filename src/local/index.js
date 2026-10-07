import { createOpusDecoder } from './connection.js';
import { createLocalPlayerCli } from './cli.js';
import { createSink, SINK_CHOICES } from './sinks.js';
import { spawnAsync } from '../search.js';

const USAGE = `使い方: bun run player [--sink <${SINK_CHOICES.join('|')}>] [--out <path>]
  --sink   出力先。既定は auto（ffplay → aplay の順に検出）。wav は --out と併用。
  --out    --sink wav の出力ファイルパス

ローカル環境で Bot の再生経路（yt-dlp → FFmpeg → MixStream → AudioPlayer）を
そのまま動かし、Discord VC の代わりにローカルの音声出力へ流す開発用 CLI です。
対話モードで play/pause/skip/queue などを実行できます。`;

function parseArgs(argv) {
  const args = { sink: 'auto', out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--sink') { args.sink = argv[++i]; }
    else if (a === '--out') { args.out = argv[++i]; }
    else if (a.startsWith('--sink=')) args.sink = a.slice('--sink='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else throw new Error(`不明な引数: ${a}`);
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // yt-dlp is the same external binary the bot spawns for every source.
  try {
    const version = await spawnAsync('yt-dlp', ['--version'], { timeoutMs: 10_000 });
    console.log(`yt-dlp ${version}`);
  } catch {
    console.error('❌ yt-dlp が見つかりません。`bun run player` には PATH 上の yt-dlp が必要です');
    process.exitCode = 1;
    return;
  }

  const decode = await createOpusDecoder();
  const sink = await createSink({ sink: args.sink, out: args.out });

  const cli = createLocalPlayerCli({ sink, decode });
  process.on('SIGINT', () => { cli.shutdown().finally(() => process.exit(0)); });
  await cli.run();
}

main().catch((err) => {
  console.error('❌ 起動に失敗しました:', err);
  process.exitCode = 1;
});
