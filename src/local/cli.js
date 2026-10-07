import { createInterface } from 'node:readline';
import { GuildPlayer } from '../player.js';
import { GuildQueue } from '../queue.js';
import {
  isPlaylistUrl,
  mapEntryToTrack,
  resolveFlatPlaylist,
  resolveMetadata,
  searchYoutube,
  PLAYLIST_LIMIT,
} from '../search.js';
import { getGuildSettings, setFade, setNormalize } from '../settings.js';
import { fmtDuration, LOOP_LABELS } from '../format.js';
import { LocalVoiceConnection } from './connection.js';

export const LOCAL_GUILD_ID = 'local';
export const LOCAL_REQUESTED_BY = 'local-cli';

const HELP_TEXT = `コマンド一覧:
  play <URL|キーワード>  再生（プレイリスト URL 対応 / キーワードは検索して番号選択）
  pause                 一時停止
  resume                再開
  skip                  スキップ
  stop                  再生停止 + キュークリア
  queue                 キュー一覧
  shuffle               キューをシャッフル
  loop                  ループ切り替え（オフ→1曲→キュー）
  np                    再生中の曲（now playing）
  fade <on|off>         クロスフェード切り替え（既定 on）
  normalize <on|off>    音量ノーマライズ切り替え
  status                接続/再生状態
  help                  このヘルプ
  quit                  終了`;

function fmtTrackLine(track, prefix = '') {
  const dur = fmtDuration(track.duration);
  const by = track.requestedBy ? ` (req: ${track.requestedBy})` : '';
  return `${prefix}${track.title} [${dur}]${by}`;
}

/**
 * Interactive REPL driving a real GuildPlayer against a LocalVoiceConnection.
 * Session lifecycle mirrors the bot: a session is created lazily by `play`
 * and torn down when the queue exhausts (GuildPlayer -> onDisconnect).
 *
 * @param {{ sink: { name: string, write(buf): boolean, close(): Promise<void> }, decode: (packet: Buffer) => Buffer, output?: object, input?: object, searchFn?: Function }} deps
 */
export function createLocalPlayerCli({ sink, decode, output = process.stdout, input = process.stdin, searchFn = searchYoutube } = {}) {
  const rl = createInterface({ input, terminal: input.isTTY === true });
  let session = null;
  let pendingAnswer = null;
  let closed = false;
  let busy = false;
  let commandChain = Promise.resolve();
  const heldLines = [];

  // rl.prompt() throws ERR_USE_AFTER_CLOSE once stdin EOFs (piped input),
  // while queued commands may still be finishing — guard every prompt.
  const prompt = () => { if (!rl.closed) rl.prompt(); };

  const say = (...args) => {
    output.write(`${args.join(' ')}\n`);
    prompt();
  };

  function ensureSession() {
    if (session) return session;
    const queue = new GuildQueue();
    const connection = new LocalVoiceConnection({ sink, decode });
    let created;
    const player = new GuildPlayer({
      guildId: LOCAL_GUILD_ID,
      connection,
      queue,
      onDisconnect: async () => {
        // Mirror sessions.js: only tear down if this is still the live session.
        if (session !== created) return;
        session = null;
        say('🔚 キューが空になりました（ローカルセッション終了）');
        // Defer teardown until the trackend->handleAfter chain unwinds.
        setImmediate(() => {
          connection.destroy();
          player.stop().catch(() => {});
        });
      },
      onTrackStart: () => {
        const current = queue.current;
        if (current) say(`▶ 再生開始: ${fmtTrackLine(current)}`);
      },
    });
    created = { connection, queue, player };
    session = created;
    return created;
  }

  async function cmdPlay(query) {
    if (!query) { say('❌ 使い方: play <URL または キーワード>'); return; }
    const isUrl = /^https?:\/\//.test(query);
    let tracks = [];
    if (isUrl) {
      if (isPlaylistUrl(query)) {
        say('⏳ プレイリストを取得中...');
        const { tracks: list, truncated } = await resolveFlatPlaylist(query, { requestedBy: LOCAL_REQUESTED_BY });
        tracks = list;
        if (truncated) say(`⚠️ プレイリストが大きいため先頭 ${PLAYLIST_LIMIT} 件のみ追加します`);
      } else {
        say('⏳ メタデータを取得中...');
        tracks = [await resolveMetadata(query, { requestedBy: LOCAL_REQUESTED_BY })];
      }
    } else {
      say('⏳ 検索中...');
      const results = await searchFn(query);
      if (!results.length) { say('❌ 検索結果が見つかりませんでした'); return; }
      results.forEach((entry, i) => {
        say(`  ${i + 1}. ${entry.title ?? 'Unknown'} [${fmtDuration(entry.duration)}] ${entry.channel ?? ''}`);
      });
      const answer = await ask(`番号を選択 (1-${results.length}, c でキャンセル): `);
      if (!/^\d+$/.test(answer) || !results[Number(answer) - 1]) { say('キャンセルしました'); return; }
      tracks = [mapEntryToTrack(results[Number(answer) - 1], { requestedBy: LOCAL_REQUESTED_BY })];
    }
    if (!tracks.length) { say('❌ 追加する曲がありません'); return; }
    const s = ensureSession();
    const wasEmpty = s.queue.isEmpty;
    for (const track of tracks) s.queue.add(track);
    if (tracks.length === 1) say(`✅ キューに追加: ${fmtTrackLine(tracks[0])}`);
    else say(`✅ ${tracks.length} 曲をキューに追加しました`);
    if (wasEmpty) {
      say('⏳ 再生を開始します...');
      await s.player.playNext();
    }
  }

  function ask(question) {
    output.write(`${question}\n`);
    prompt();
    return new Promise((resolve) => {
      pendingAnswer = resolve;
      // A line typed before this question posted (piped input or a fast
      // typist) is held — the earliest one answers it.
      if (heldLines.length) resolveAnswer(heldLines.shift());
    });
  }

  // yt-dlp stderr noise that occasionally lands in error messages.
  function cleanError(err) {
    return String(err?.message ?? err)
      .split('\n')
      .filter((line) => !/Deprecated Feature|^\s*WARNING:/.test(line))
      .join('\n')
      .trim();
  }

  async function handleCommand(line) {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    try {
      switch (cmd) {
        case 'play':
        case 'p':
          await cmdPlay(arg);
          break;
        case 'pause':
          if (!requireSession()) break;
          say(session.player.pause() ? '⏸️ 一時停止しました' : '❌ 一時停止できませんでした');
          break;
        case 'resume':
          if (!requireSession()) break;
          say(session.player.resume() ? '▶️ 再開しました' : '❌ 再開できませんでした');
          break;
        case 'skip':
        case 's':
          if (!requireSession()) break;
          await session.player.skip();
          say('⏭️ スキップしました');
          break;
        case 'stop':
          if (!requireSession()) break;
          await session.player.stop();
          say('⏹️ 停止してキューをクリアしました');
          break;
        case 'queue':
        case 'q': {
          if (!requireSession()) break;
          const { queue } = session;
          const current = queue.current;
          const upcoming = queue.upcoming();
          say(`🔁 ループ: ${LOOP_LABELS[queue.loopMode]}`);
          say(current ? `再生中: ${fmtTrackLine(current)}` : '再生中の曲がありません');
          if (!upcoming.length) say('（キューは空）');
          upcoming.forEach((t, i) => say(`  ${i + 1}. ${fmtTrackLine(t)}`));
          break;
        }
        case 'shuffle':
          if (!requireSession()) break;
          session.queue.shuffle();
          say('🔀 キューをシャッフルしました');
          break;
        case 'loop': {
          if (!requireSession()) break;
          const mode = session.queue.cycleLoop();
          say(`🔁 ループモード: ${LOOP_LABELS[mode]}`);
          break;
        }
        case 'np':
        case 'nowplaying': {
          if (!requireSession()) break;
          const current = session.queue.current;
          if (!current) { say('❌ 再生中の曲がありません'); break; }
          say(`🎵 ${fmtTrackLine(current)}`);
          say(`   ${fmtDuration(Math.floor(session.player.positionSec))} / ${fmtDuration(current.duration)} | 状態: ${session.player.status}`);
          break;
        }
        case 'fade':
        case 'normalize': {
          if (!/^(on|off)$/i.test(arg)) { say(`❌ 使い方: ${cmd} <on|off>`); break; }
          const enabled = arg.toLowerCase() === 'on';
          if (cmd === 'fade') { setFade(LOCAL_GUILD_ID, enabled); say(`✅ フェードを ${enabled ? '有効' : '無効'} にしました`); }
          else { setNormalize(LOCAL_GUILD_ID, enabled); say(`✅ ノーマライズを ${enabled ? '有効' : '無効'} にしました`); }
          break;
        }
        case 'status': {
          const settings = getGuildSettings(LOCAL_GUILD_ID);
          say(`接続: ${session ? session.connection.state.status : 'なし'} | プレイヤー: ${session?.player.status ?? 'なし'} | sink: ${sink.name}`);
          say(`fade=${settings.fade ? 'on' : 'off'} normalize=${settings.normalize ? 'on' : 'off'}`);
          break;
        }
        case 'help':
        case '?':
          say(HELP_TEXT);
          break;
        case 'quit':
        case 'exit':
          await shutdown();
          return;
        case '':
          break;
        default:
          say(`❓ 不明なコマンド: ${cmd}（help で一覧）`);
      }
    } catch (err) {
      say(`❌ エラー: ${cleanError(err)}`);
    }
    prompt();
  }

  function requireSession() {
    if (session) return true;
    say('❌ 再生中の曲がありません（play で開始）');
    return false;
  }

  async function shutdown() {
    if (closed) return;
    closed = true;
    const dead = session;
    session = null;
    if (dead) {
      try { await dead.player.stop(); } catch { /* already torn down */ }
      dead.connection.destroy();
    }
    try { await sink.close(); } catch { /* best effort */ }
    rl.close();
  }

  function resolveAnswer(text) {
    const resolve = pendingAnswer;
    pendingAnswer = null;
    resolve(text);
  }

  function dispatch(text) {
    busy = true;
    commandChain = commandChain
      .then(() => handleCommand(text))
      .catch(() => {})
      .finally(() => {
        busy = false;
        flushHeld();
      });
  }

  // Lines typed while a command is still running are held: when the command
  // settles, a held line either answers a pick it posted (pendingAnswer) or
  // runs as a command — in arrival order.
  function flushHeld() {
    while (heldLines.length && !busy && !closed) {
      const text = heldLines.shift();
      if (pendingAnswer) { resolveAnswer(text); continue; }
      dispatch(text);
    }
  }

  function onLine(line) {
    const text = line.trim();
    // A pending pick/answer is resolved here (outside the serial command
    // chain) — a command awaiting ask() must not block the input loop.
    if (pendingAnswer) { resolveAnswer(text); return; }
    if (closed) return;
    if (busy) { heldLines.push(text); return; }
    dispatch(text);
  }

  async function run() {
    say('🎧 ローカルプレイヤー起動（Bot の再生経路をローカル出力に接続）');
    say(`   出力: ${sink.name} | help でコマンド一覧`);
    rl.setPrompt('player> ');
    prompt();
    rl.on('line', onLine);
    await new Promise((resolve) => rl.once('close', resolve));
    // stdin EOF: cancel any open pick, then let in-flight and held commands
    // (e.g. everything buffered ahead of the EOF) run to completion.
    while (busy || heldLines.length || pendingAnswer) {
      flushHeld();
      if (pendingAnswer) resolveAnswer(heldLines.shift() ?? '');
      await commandChain;
    }
    await shutdown();
  }

  return { run, shutdown, handleCommand };
}
