import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'

import { Dashboard } from './pages/Dashboard.jsx'
import './styles.css'

function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Music Bot</p>
        <h1>Discord ログイン</h1>
        <p>ダッシュボードを使うには Discord OAuth でログインしてください。</p>
        <a className="primary-link" href="/auth/discord">Discord でログイン</a>
      </section>
    </main>
  )
}

function CallbackPage() {
  const location = useLocation()
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Callback</p>
        <h1>連携を確認しています</h1>
        <p>{location.pathname} の処理が完了したらダッシュボードに戻ります。</p>
        <Link className="primary-link" to="/">Dashboard</Link>
      </section>
    </main>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/callback/*" element={<CallbackPage />} />
      </Routes>
    </BrowserRouter>
  )
}
