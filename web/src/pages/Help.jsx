import { Link } from 'react-router-dom'

import '../landing.css'

const PLAYBACK_COMMANDS = [
  { title: '/play <query>', copy: 'YouTube の URL、またはキーワードを指定して再生します。URL 直接再生時は再生キューにそのまま追加され、プレイリスト URL の場合は先頭から一定件数がまとめて追加されます。キーワードの場合は検索結果が本人だけに見えるボタン一覧で表示され、選んだ曲がキューに追加されます。' },
  { title: '/pause', copy: '現在の再生を一時停止します。' },
  { title: '/resume', copy: '一時停止中の再生を再開します。' },
  { title: '/skip', copy: '現在の曲をスキップし、キューの次の曲を再生します。' },
  { title: '/stop', copy: '再生を停止し、キューを空にします。' },
  { title: '/leave', copy: 'ボットをボイスチャンネルから退出させ、セッションを破棄します。' },
  { title: '/queue', copy: '現在のキューを一覧表示します。並び替え・削除用のボタンが付いたエディタとして開きます。' },
  { title: '/shuffle', copy: 'キューの曲順をシャッフルします。' },
  { title: '/loop', copy: 'ループモードを「オフ → 1曲リピート → キューリピート → オフ」の順に切り替えます。実行するたびに次のモードへ進みます。' },
  { title: '/nowplaying', copy: '現在再生中の曲のタイトル・長さ・リクエストしたユーザー・ループモードを表示します。' },
]

const SETTINGS_COMMANDS = [
  { title: '/bitrate [kbps]', copy: '参加しているボイスチャンネルのビットレートを設定します。数値を省略するとサーバーの Boost レベル（Premium Tier）に応じた上限値が使われます。指定した値が上限を超える場合は自動的に上限まで丸められます。' },
  { title: '/normalize <enabled>', copy: '曲ごとの音量ノーマライズを有効・無効にします。サーバー単位の設定で、以降に再生する曲に適用されます。' },
  { title: '/autoplay mode <value>', copy: 'キューが空になったときの自動再生モードを設定します。オフ / 自動（関連動画から自動追加）/ おすすめ（DM でおすすめを提示し選んで追加）の3種類です。' },
  { title: '/autoplay personalize <value>', copy: '自動再生のパーソナライズ機能を on/off します。有効にすると、これまでの再生履歴を考慮した候補が選ばれやすくなります。' },
  { title: '/autoplay notify <value>', copy: '自動再生で曲がキューに追加された際に通知を送るかどうかを切り替えます。' },
]

const OTHER_COMMANDS = [
  { title: '/help', copy: 'このページの内容を要約したコマンド一覧を、実行した本人にだけ見える形で表示します。' },
]

/** @param {{ eyebrow: string, title: string, commands: { title: string, copy: string }[] }} props */
function CommandSection({ eyebrow, title, commands }) {
  return (
    <section className="landing-section" aria-labelledby={`${eyebrow}-title`}>
      <div className="section-heading landing-section-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={`${eyebrow}-title`}>{title}</h2>
      </div>
      <div className="feature-grid">
        {commands.map((command) => (
          <article className="feature-card" key={command.title}>
            <h3>{command.title}</h3>
            <p>{command.copy}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

export function Help() {
  return (
    <main className="landing-page">
      <header className="landing-nav" aria-label="Play-bot navigation">
        <Link className="brand-link" to="/">Play-bot</Link>
        <nav className="landing-nav-actions" aria-label="Primary navigation">
          <Link to="/dashboard">ダッシュボードへ戻る</Link>
        </nav>
      </header>

      <section className="landing-section" aria-labelledby="help-title">
        <div className="landing-copy">
          <p className="eyebrow">Play-bot | Help</p>
          <h1 id="help-title">コマンドの使い方</h1>
          <p className="landing-lead">
            Discord 上の <code>/help</code> コマンドで表示される一覧の詳細版です。
            各スラッシュコマンドの引数や挙動をまとめています。
          </p>
        </div>
      </section>

      <CommandSection eyebrow="Playback" title="再生操作" commands={PLAYBACK_COMMANDS} />
      <CommandSection eyebrow="Settings" title="設定" commands={SETTINGS_COMMANDS} />
      <CommandSection eyebrow="Other" title="その他" commands={OTHER_COMMANDS} />

      <footer className="landing-footer">
        <span>Play-bot</span>
        <nav aria-label="Legal links">
          <a href="https://agreement.blazex60.com/terms">利用規約</a>
          <a href="https://agreement.blazex60.com/privacy">プライバシーポリシー</a>
        </nav>
      </footer>
    </main>
  )
}
