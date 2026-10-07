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
 * @param {{ sink: { name: string, write(buf): boolean, close(): Promise<void> }, decode: (packet: Buffer) => Buffer }} deps
 */
export function createLocalPlayerCli({ sink, decode, output = process.stdout } = {}) {
  const rl = createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });
  let session = null;
  let pendingAnswer = null;
  let closed = false;

  const say = (...args) => {
    output.write(`${args.join(' ')}\n`);
    rl.prompt();
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
      const results = await searchYoutube(query);
      if (!results.length) { say('❌ 検索結果が見つかりませんでした'); return; }
      results.forEach((entry, i) => {
        say(`  ${i + 1}. ${entry.title ?? 'Unknown'} [${fmtDuration(entry.duration)}] ${entry.channel ?? ''}`);
      });
      const answer = await ask('番号を選択 (1-5, c でキャンセル): ');
      if (!/^[1-5]$/.test(answer) || !results[Number(answer) - 1]) { say('キャンセルしました'); return; }
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
    rl.prompt();
    return new Promise((resolve) => { pendingAnswer = resolve; });
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
      say(`❌ エラー: ${err.message}`);
    }
    if (!closed) rl.prompt();
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

  async function run() {
    say('🎧 ローカルプレイヤー起動（Bot の再生経路をローカル出力に接続）');
    say(`   出力: ${sink.name} | help でコマンド一覧`);
    rl.setPrompt('player> ');
    rl.prompt();
    try {
      for await (const line of rl) {
        if (closed) break;
        const text = line.trim();
        if (pendingAnswer) {
          const resolve = pendingAnswer;
          pendingAnswer = null;
          resolve(text);
          continue;
        }
        await handleCommand(text);
        if (closed) break;
      }
    } finally {
      await shutdown();
    }
  }

  return { run, shutdown, handleCommand };
}
