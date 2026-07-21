import { useState } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom'

import { Admin } from './pages/Admin.jsx'
import { Dashboard } from './pages/Dashboard.jsx'
import { Landing } from './pages/Landing.jsx'
import './styles.css'

function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Play-bot</p>
        <h1>Discord ログイン</h1>
        <p>ダッシュボードを使うには Discord OAuth でログインしてください。</p>
        <a className="primary-link" href="/auth/discord?redirect=/dashboard">Discord でログイン</a>
        <Link className="secondary-link" to="/">ランディングへ戻る</Link>
      </section>
    </main>
  )
}

function DemoLoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  /** @param {import('react').SubmitEvent<HTMLFormElement>} event */
  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setError(false)
    try {
      const response = await fetch('/auth/demo/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (response.ok) {
        window.location.href = '/dashboard'
        return
      }
      setError(true)
    } catch {
      setError(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Play-bot</p>
        <h1>デモログイン</h1>
        <p>審査担当者向けのパスワード保護されたログインです。</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="パスワード"
            autoComplete="current-password"
            aria-label="パスワード"
          />
          <button type="submit" className="primary-link" disabled={submitting}>
            ログイン
          </button>
        </form>
        {error && <p role="alert">ログインできませんでした</p>}
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
        <Link className="primary-link" to="/dashboard">Dashboard</Link>
      </section>
    </main>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/demo" element={<DemoLoginPage />} />
        <Route path="/callback/*" element={<CallbackPage />} />
      </Routes>
    </BrowserRouter>
  )
}
