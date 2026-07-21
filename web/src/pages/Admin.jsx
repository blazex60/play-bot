import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { api, ApiError } from '../api/client.js'
import '../dashboard.css'
import { PermissionMatrix } from '../components/PermissionMatrix.jsx'
import { VisibilityPanel } from '../components/VisibilityPanel.jsx'
import { OperationLogTable } from '../components/OperationLogTable.jsx'

const LOG_PAGE_SIZE = 50

function initialGuildId() {
  const params = new URLSearchParams(window.location.search)
  return params.get('guildId') ?? window.localStorage.getItem('musicbot:guildId') ?? ''
}

export function Admin() {
  const [guildId] = useState(initialGuildId)
  const [permission, setPermission] = useState(/** @type {{ extended?: boolean } | null} */ (null))
  const [permissions, setPermissions] = useState(
    /** @type {import('../api/client.js').AdminPermissions} */ ({ commands: [], defaults: {}, overrides: {}, knownUsers: [] })
  )
  const [visibility, setVisibility] = useState(/** @type {import('../api/client.js').AdminVisibility} */ ({}))
  const [logs, setLogs] = useState(/** @type {import('../api/client.js').OperationLogEntry[]} */ ([]))
  const [hasMoreLogs, setHasMoreLogs] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const showError = useCallback((/** @type {unknown} */ error) => {
    if (error instanceof ApiError && error.status === 401) {
      window.location.assign('/login')
      return
    }
    setMessage(error instanceof Error ? error.message : '操作に失敗しました')
  }, [])

  const loadLogs = useCallback(async (/** @type {number | undefined} */ before = undefined) => {
    const payload = await api.adminLogs(guildId, before ? { limit: LOG_PAGE_SIZE, before } : { limit: LOG_PAGE_SIZE })
    const rows = typeof payload === 'object' && payload !== null && Array.isArray(payload.logs) ? payload.logs : []
    setHasMoreLogs(rows.length === LOG_PAGE_SIZE)
    return rows
  }, [guildId])

  useEffect(() => {
    if (!guildId) return
    api.permission({ guildId }).then((payload) => {
      setPermission(/** @type {{ extended?: boolean }} */ (payload))
      if (!payload?.extended) return
      api.adminPermissions(guildId).then((data) => setPermissions(/** @type {import('../api/client.js').AdminPermissions} */ (data))).catch(showError)
      api.adminVisibility(guildId).then((data) => setVisibility(/** @type {import('../api/client.js').AdminVisibility} */ (data))).catch(showError)
      loadLogs().then(setLogs).catch(showError)
    }).catch(showError)
  }, [guildId, loadLogs, showError])

  async function loadMoreLogs() {
    setBusy(true)
    try {
      const lastId = logs.at(-1)?.id
      const rows = await loadLogs(lastId)
      setLogs((current) => [...current, ...rows])
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** @param {string} command @param {'allow'|'deny'} value */
  async function setDefaultPermission(command, value) {
    setBusy(true)
    setMessage('')
    try {
      await api.setDefaultCommandPermission(guildId, command, value)
      setPermissions((current) => ({ ...current, defaults: { ...current.defaults, [command]: value } }))
      setMessage('デフォルト権限を更新しました')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** @param {string} userId @param {string} command @param {'allow'|'deny'|null} value */
  async function setUserOverride(userId, command, value) {
    setBusy(true)
    setMessage('')
    try {
      await api.setUserCommandPermission(guildId, userId, command, value)
      setPermissions((current) => {
        const userOverrides = { ...(current.overrides[userId] ?? {}) }
        if (value === null) {
          delete userOverrides[command]
        } else {
          userOverrides[command] = value
        }
        const overrides = { ...current.overrides }
        if (Object.keys(userOverrides).length > 0) {
          overrides[userId] = userOverrides
        } else {
          delete overrides[userId]
        }
        return { ...current, overrides }
      })
      setMessage('ユーザー権限を更新しました')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** @param {string} command @param {'public'|'personal'} value */
  async function setVisibilityValue(command, value) {
    setBusy(true)
    setMessage('')
    try {
      await api.setCommandVisibility(guildId, command, value)
      setVisibility((current) => ({ ...current, [command]: value }))
      setMessage('表示設定を更新しました')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  if (!guildId) {
    return (
      <main className="dashboard-shell">
        <p className="status-message" role="status">Guild ID が指定されていません。ダッシュボードから Guild ID を設定してください。</p>
        <Link className="primary-link" to="/dashboard">Dashboardへ戻る</Link>
      </main>
    )
  }

  if (permission && !permission.extended) {
    return (
      <main className="dashboard-shell">
        <p className="status-message" role="status">このサーバーの管理者権限がないため、管理画面にはアクセスできません。</p>
        <Link className="primary-link" to="/dashboard">Dashboardへ戻る</Link>
      </main>
    )
  }

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div>
            <p className="eyebrow">Discord Music Bot</p>
            <h1>管理画面</h1>
          </div>
        </div>
        <div className="header-meta">
          <Link className="ghost-button" to={`/dashboard?guildId=${encodeURIComponent(guildId)}`}>Dashboardへ戻る</Link>
        </div>
      </header>

      {message ? <p className="status-message" role="status">{message}</p> : null}

      {permission?.extended ? (
        <div className="admin-grid">
          <PermissionMatrix
            commands={permissions.commands}
            defaults={permissions.defaults}
            overrides={permissions.overrides}
            knownUsers={permissions.knownUsers}
            busy={busy}
            onSetDefault={setDefaultPermission}
            onSetUserOverride={setUserOverride}
          />
          <VisibilityPanel
            commands={permissions.commands}
            visibility={visibility}
            busy={busy}
            onChange={setVisibilityValue}
          />
          <OperationLogTable logs={logs} busy={busy} hasMore={hasMoreLogs} onLoadMore={loadMoreLogs} />
        </div>
      ) : (
        <p className="empty-copy">権限を確認しています…</p>
      )}
    </main>
  )
}
