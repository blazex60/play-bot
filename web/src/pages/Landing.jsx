import { Link } from 'react-router-dom'

import '../landing.css'

const FEATURES = [
  {
    title: 'Discord VC をそのまま操作',
    copy: '再生、一時停止、スキップ、音量調整、キュー編集をブラウザからまとめて操作できます。',
  },
  {
    title: 'YouTube プレイリスト取り込み',
    copy: 'Google / YouTube 連携は、ユーザー自身の YouTube プレイリストを読み取り、選択した曲を Discord の再生キューに追加するために使用します。',
  },
  {
    title: '自宅運用向けの安全な境界',
    copy: 'Bot API は loopback のみ、公開面は Web ダッシュボードだけに分けた構成です。',
  },
]

export function Landing() {
  return (
    <main className="landing-page">
      <header className="landing-nav" aria-label="Play-bot navigation">
        <Link className="brand-link" to="/">Play-bot</Link>
        <nav className="landing-nav-actions" aria-label="Primary navigation">
          <Link to="/help">ヘルプ</Link>
          <Link to="/login">ログイン</Link>
          <Link className="primary-link" to="/dashboard">Dashboard</Link>
        </nav>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-copy">
          <p className="eyebrow">Play-bot | Discord VC Music Control</p>
          <h1 id="landing-title">Play-bot は Discord VC 用の音楽 Bot です。</h1>
          <p className="landing-lead">
            Play-bot は、Discord ボイスチャンネルで YouTube 音楽を再生・管理するための Web ダッシュボード付き Discord Bot です。
            再生、一時停止、スキップ、キュー編集、YouTube プレイリスト取り込みをひとつの画面に集約します。
            未ログインでもこのページで概要を確認し、必要なときだけ Discord OAuth で入れます。
          </p>
          <div className="landing-cta-group">
            <a className="primary-link" href="/auth/discord?redirect=/dashboard">Discord でログイン</a>
            <Link className="secondary-link" to="/dashboard">ダッシュボードへ</Link>
          </div>
        </div>

        <aside className="hero-preview" aria-label="Dashboard preview">
          <div className="preview-topline">
            <span>Now Playing</span>
            <span>VC ready</span>
          </div>
          <div className="preview-track">
            <div className="preview-art" aria-hidden="true" />
            <div>
              <p>Lo-fi Study Mix</p>
              <span>YouTube playlist import</span>
            </div>
          </div>
          <div className="preview-controls" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <ol className="preview-queue" aria-label="Preview queue">
            <li><span>01</span>Queue One</li>
            <li><span>02</span>Queue Two</li>
            <li><span>03</span>Queue Three</li>
          </ol>
        </aside>
      </section>

      <section className="landing-section" aria-labelledby="features-title">
        <div className="section-heading landing-section-heading">
          <p className="eyebrow">What it does</p>
          <h2 id="features-title">Bot 操作に必要な面だけを公開します。</h2>
        </div>
        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <article className="feature-card" key={feature.title}>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
      </section>

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
