import { createInterface } from 'node:readline';
import { GuildPlayer } from '../playback/player.js';
import { GuildQueue } from '../playback/queue.js';
import { PlaybackService } from '../playback/playbackService.js';
import {
  isPlaylistUrl,
  mapEntryToTrack,
  resolveFlatPlaylist,
  resolveMetadata,
  searchYoutube,
  PLAYLIST_LIMIT,
} from '../media/search.js';
import { getGuildSettings, setFade, setNormalize } from '../shared/settings.js';
import { fmtDuration, LOOP_LABELS } from '../shared/format.js';
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
  seek <±秒|mm:ss>      シーク（例: seek 90, seek +10, seek -10, seek 1:30）
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
 * Parse a seek argument into seconds.
 * Accepts `90`, `1:30`, `1:02:30`, and `+10` / `-10` relative offsets.
 * @returns {{ sec: number, relative: boolean } | null}
 */
export function parseSeekArg(arg) {
  const text = String(arg ?? '').trim();
  const m = text.match(/^([+-])?\s*(?:(\d+):(\d{1,2}):(\d{1,2})|(\d+):(\d{1,2})|(\d+(?:\.\d+)?))$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  let sec;
  if (m[2] != null) sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  else if (m[5] != null) sec = Number(m[5]) * 60 + Number(m[6]);
  else sec = Number(m[7]);
  if (!Number.isFinite(sec)) return null;
  return { sec: sign * sec, relative: m[1] != null };
}

export function progressBar(positionSec, durationSec, width = 20) {
  if (durationSec == null || durationSec <= 0) return '';
  const frac = Math.min(1, Math.max(0, positionSec / durationSec));
  const filled = Math.round(frac * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
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
  // Single-session adapter: the CLI is its own sessions map, so the service
  // resolves the one live session regardless of the guildId passed in.
  const playback = new PlaybackService({ getSession: () => session });
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
    ensureSession();
    await playback.enqueue(LOCAL_GUILD_ID, tracks, {
      onEnqueued: async ({ wasEmpty }) => {
        if (tracks.length === 1) say(`✅ キューに追加: ${fmtTrackLine(tracks[0])}`);
        else say(`✅ ${tracks.length} 曲をキューに追加しました`);
        if (wasEmpty) say('⏳ 再生を開始します...');
      },
    });
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
          say(playback.pause(LOCAL_GUILD_ID) ? '⏸️ 一時停止しました' : '❌ 一時停止できませんでした');
          break;
        case 'resume':
          if (!requireSession()) break;
          say(playback.resume(LOCAL_GUILD_ID) ? '▶️ 再開しました' : '❌ 再開できませんでした');
          break;
        case 'skip':
        case 's':
          if (!requireSession()) break;
          await playback.skip(LOCAL_GUILD_ID);
          say('⏭️ スキップしました');
          break;
        case 'stop':
          if (!requireSession()) break;
          await playback.stop(LOCAL_GUILD_ID);
          say('⏹️ 停止してキューをクリアしました');
          break;
        case 'queue':
        case 'q': {
          if (!requireSession()) break;
          const state = playback.getState(LOCAL_GUILD_ID);
          const current = state.current;
          const upcoming = state.upcoming;
          say(`🔁 ループ: ${LOOP_LABELS[state.loopMode]}`);
          say(current ? `再生中: ${fmtTrackLine(current)}` : '再生中の曲がありません');
          if (!upcoming.length) say('（キューは空）');
          upcoming.forEach((t, i) => say(`  ${i + 1}. ${fmtTrackLine(t)}`));
          break;
        }
        case 'shuffle':
          if (!requireSession()) break;
          playback.shuffle(LOCAL_GUILD_ID);
          say('🔀 キューをシャッフルしました');
          break;
        case 'loop': {
          if (!requireSession()) break;
          const mode = playback.cycleLoop(LOCAL_GUILD_ID);
          say(`🔁 ループモード: ${LOOP_LABELS[mode]}`);
          break;
        }
        case 'seek': {
          if (!requireSession()) break;
          const parsed = parseSeekArg(arg);
          if (!parsed) { say('❌ 使い方: seek <秒|mm:ss|+N|-N>'); break; }
          const pos = playback.getState(LOCAL_GUILD_ID).positionSec;
          const target = parsed.relative ? Math.max(0, pos + parsed.sec) : parsed.sec;
          const applied = await playback.seekTo(LOCAL_GUILD_ID, target);
          if (applied !== false) {
            say(`⏩ ${fmtDuration(Math.floor(applied))} へシークしました`);
          } else {
            say('❌ シークできませんでした（再生中でないか、トランジション中です）');
          }
          break;
        }
        case 'np':
        case 'nowplaying': {
          if (!requireSession()) break;
          const state = playback.getState(LOCAL_GUILD_ID);
          const current = state.current;
          if (!current) { say('❌ 再生中の曲がありません'); break; }
          const pos = Math.floor(state.positionSec);
          const bar = progressBar(state.positionSec, current.duration);
          say(`🎵 ${fmtTrackLine(current)}`);
          say(`   ${bar ? `${bar} ` : ''}${fmtDuration(pos)} / ${fmtDuration(current.duration)} | 状態: ${state.status}`);
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
          say(`接続: ${session ? session.connection.state.status : 'なし'} | プレイヤー: ${playback.getState(LOCAL_GUILD_ID).status} | sink: ${sink.name}`);
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
      // Race, not a plain await: an in-flight command may post a pick
      // (pendingAnswer) that only this loop can still answer post-EOF —
      // awaiting the chain unconditionally would deadlock on it.
      await Promise.race([commandChain, new Promise((resolve) => setImmediate(resolve))]);
    }
    await shutdown();
  }

  return { run, shutdown, handleCommand };
}
