import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, ApiError } from '../api/client.js'
import '../dashboard.css'
import { AutoplayPanel } from '../components/AutoplayPanel.jsx'
import { MatchReview } from '../components/MatchReview.jsx'
import { NowPlaying } from '../components/NowPlaying.jsx'
import { PlaylistBuilder } from '../components/PlaylistBuilder.jsx'
import { PlaylistPanel } from '../components/PlaylistPanel.jsx'
import { QueueList } from '../components/QueueList.jsx'
import { TransportControls } from '../components/TransportControls.jsx'

function initialGuildId() {
  const params = new URLSearchParams(window.location.search)
  return params.get('guildId') ?? window.localStorage.getItem('musicbot:guildId') ?? ''
}

/** @param {unknown} payload @returns {import('../api/client.js').ServiceLink[]} */
function normalizeLinks(payload) {
  if (typeof payload !== 'object' || payload === null || !('services' in payload) || !Array.isArray(payload.services)) {
    return []
  }
  return payload.services
}

/** @param {unknown} payload @returns {import('../api/client.js').PlaybackState} */
function normalizeState(payload) {
  if (typeof payload === 'object' && payload !== null && 'state' in payload) {
    return /** @type {import('../api/client.js').PlaybackState} */ (payload.state)
  }
  if (typeof payload === 'object' && payload !== null) {
    return /** @type {import('../api/client.js').PlaybackState} */ (payload)
  }
  return { active: false, upcoming: [] }
}

export function Dashboard() {
  const [guildId, setGuildId] = useState(initialGuildId)
  const [user, setUser] = useState(/** @type {import('../api/client.js').User | null} */ (null))
  const [state, setState] = useState(/** @type {import('../api/client.js').PlaybackState} */ ({ active: false, upcoming: [] }))
  const [links, setLinks] = useState(/** @type {import('../api/client.js').ServiceLink[]} */ ([]))
  const [playlists, setPlaylists] = useState(/** @type {import('../api/client.js').Playlist[]} */ ([]))
  const [selectedService, setSelectedService] = useState('youtube')
  const [selectedPlaylist, setSelectedPlaylist] = useState(/** @type {import('../api/client.js').Playlist | null} */ (null))
  const [importJob, setImportJob] = useState(/** @type {import('../api/client.js').ImportJob | null} */ (null))
  const [reviewTracks, setReviewTracks] = useState(/** @type {import('../api/client.js').ImportTrack[]} */ ([]))
  const [searchQuery, setSearchQuery] = useState('')
  const [volume, setVolume] = useState(1)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [savedPlaylists, setSavedPlaylists] = useState(/** @type {import('../api/client.js').SavedPlaylist[]} */ ([]))
  const [selectedSavedPlaylist, setSelectedSavedPlaylist] = useState(
    /** @type {import('../api/client.js').SavedPlaylist | null} */ (null)
  )
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [trackUrl, setTrackUrl] = useState('')
  const [trackSearchQuery, setTrackSearchQuery] = useState('')
  const [trackSearchResults, setTrackSearchResults] = useState(
    /** @type {import('../api/client.js').SavedPlaylistTrack[]} */ ([])
  )

  const queue = useMemo(() => state.upcoming ?? state.queue ?? [], [state])
  const autoplayMode = state.autoplayMode ?? 'off'
  const personalize = state.personalize ?? false

  const showError = useCallback((/** @type {unknown} */ error) => {
    if (error instanceof ApiError && error.status === 401) {
      window.location.assign('/login')
      return
    }
    setMessage(error instanceof Error ? error.message : '操作に失敗しました')
  }, [])

  const refreshState = useCallback(async () => {
    if (!guildId) return
    try {
      setState(normalizeState(await api.state(guildId)))
    } catch (error) {
      showError(error)
    }
  }, [guildId, showError])

  const refreshSavedPlaylists = useCallback(async () => {
    try {
      const payload = await api.mySavedPlaylists()
      if (typeof payload === 'object' && payload !== null && 'playlists' in payload && Array.isArray(payload.playlists)) {
        setSavedPlaylists(payload.playlists)
      }
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    api.me().then((payload) => {
      if (typeof payload === 'object' && payload !== null && 'user' in payload) {
        setUser(/** @type {import('../api/client.js').User} */ (payload.user))
      }
    }).catch(showError)
    api.links().then((payload) => setLinks(normalizeLinks(payload))).catch(showError)
    refreshSavedPlaylists()
  }, [showError, refreshSavedPlaylists])

  useEffect(() => {
    if (!guildId) return undefined
    window.localStorage.setItem('musicbot:guildId', guildId)
    refreshState()
    const timer = window.setInterval(refreshState, 5_000)
    return () => window.clearInterval(timer)
  }, [guildId, refreshState])

  /** @param {() => Promise<void>} work @param {string} successMessage */
  async function runAction(work, successMessage) {
    setBusy(true)
    setMessage('')
    try {
      await work()
      setMessage(successMessage)
      await refreshState()
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  /** @param {string} value */
  function updateGuildId(value) {
    setGuildId(value.trim())
  }

  async function handleLogout() {
    try {
      await api.logout()
    } finally {
      window.location.assign('/login')
    }
  }

  /** @param {string} action */
  function control(action) {
    return runAction(() => api.control(guildId, action, action === 'volume' ? { level: volume } : {}), '操作を送信しました')
  }

  /** @param {string} mode */
  function setAutoplayModeAction(mode) {
    return runAction(() => api.control(guildId, 'autoplay', { mode }), '自動再生モードを更新しました')
  }

  /** @param {boolean} enabled */
  function setPersonalizeAction(enabled) {
    return runAction(() => api.control(guildId, 'autoplay', { personalize: enabled }), 'パーソナライズを更新しました')
  }

  /** @param {number} level */
  function changeVolume(level) {
    setVolume(level)
    return runAction(() => api.control(guildId, 'volume', { level }), '音量を更新しました')
  }

  /** @param {number} fromIndex @param {number} toIndex */
  function moveQueue(fromIndex, toIndex) {
    return runAction(() => api.queue(guildId, 'move', { fromIndex, toIndex }), 'キューを並べ替えました')
  }

  /** @param {number} index */
  function removeQueue(index) {
    return runAction(() => api.queue(guildId, 'remove', { index }), 'キューから削除しました')
  }

  /** @param {string} service */
  async function loadPlaylists(service) {
    await runAction(async () => {
      const payload = await api.playlists(service)
      if (typeof payload === 'object' && payload !== null && 'playlists' in payload && Array.isArray(payload.playlists)) {
        setPlaylists(payload.playlists)
      }
      setSelectedPlaylist(null)
    }, 'プレイリストを取得しました')
  }

  async function importPlaylist() {
    if (!selectedPlaylist) return
    await runAction(async () => {
      const job = /** @type {import('../api/client.js').ImportJob} */ (await api.importPlaylist(guildId, {
        service: selectedService,
        playlistId: selectedPlaylist.id,
        playlistName: selectedPlaylist.name,
      }))
      setImportJob(job)
      const trackPayload = await api.importTracks(job.jobId)
      if (typeof trackPayload === 'object' && trackPayload !== null && 'tracks' in trackPayload && Array.isArray(trackPayload.tracks)) {
        setReviewTracks(trackPayload.tracks)
      }
    }, '取り込みを開始しました')
  }

  /** @param {string} service */
  async function relink(service) {
    await runAction(async () => {
      const payload = await api.relink(service)
      if (typeof payload === 'object' && payload !== null && 'redirectUrl' in payload && typeof payload.redirectUrl === 'string') {
        window.location.assign(payload.redirectUrl)
      }
    }, '再連携へ移動します')
  }

  /** @param {string} service */
  async function disconnect(service) {
    await runAction(async () => {
      const payload = await api.disconnect(service)
      if (typeof payload === 'object' && payload !== null && 'service' in payload && typeof payload.service === 'string') {
        setLinks((currentLinks) => currentLinks.map((link) => (link.service === payload.service ? payload : link)))
      }
      if (service === selectedService) {
        setPlaylists([])
        setSelectedPlaylist(null)
      }
    }, '連携を解除しました')
  }

  async function searchReplacement() {
    if (reviewTracks.length === 0) return
    await runAction(async () => {
      const firstTrack = reviewTracks[0]
      if (!firstTrack) return
      const payload = await api.searchImportTrack(firstTrack.id, searchQuery)
      const replacement = typeof payload === 'object' && payload !== null && 'results' in payload && Array.isArray(payload.results)
        ? payload.results[0]
        : null
      setReviewTracks((tracks) => tracks.map((track, index) => (index === 0 ? { ...track, replacement } : track)))
    }, '候補を取得しました')
  }

  /** @param {import('../api/client.js').ImportTrack} track */
  async function replaceTrack(track) {
    if (!importJob) return
    await runAction(async () => {
      await api.replaceImportTrack(track.id, { youtubeResult: track.replacement })
      const payload = await api.importTracks(importJob.jobId)
      if (typeof payload === 'object' && payload !== null && 'tracks' in payload && Array.isArray(payload.tracks)) {
        setReviewTracks(payload.tracks)
      }
    }, '曲を差し替えました')
  }

  /** @param {unknown} tracks */
  function updateSelectedTracks(tracks) {
    if (!Array.isArray(tracks)) return
    setSelectedSavedPlaylist((current) => (current ? { ...current, tracks } : current))
  }

  async function createSavedPlaylist() {
    const name = newPlaylistName.trim()
    if (!name) return
    await runAction(async () => {
      await api.createSavedPlaylist(name)
      setNewPlaylistName('')
      await refreshSavedPlaylists()
    }, 'プレイリストを作成しました')
  }

  /** @param {import('../api/client.js').SavedPlaylist} playlist */
  async function selectSavedPlaylist(playlist) {
    await runAction(async () => {
      const detail = /** @type {import('../api/client.js').SavedPlaylist} */ (await api.savedPlaylist(playlist.id))
      setSelectedSavedPlaylist(detail)
      setRenameValue(detail.name)
      setTrackSearchResults([])
    }, 'プレイリストを読み込みました')
  }

  async function renameSavedPlaylist() {
    if (!selectedSavedPlaylist) return
    const name = renameValue.trim()
    if (!name) return
    await runAction(async () => {
      await api.renameSavedPlaylist(selectedSavedPlaylist.id, name)
      setSelectedSavedPlaylist((current) => (current ? { ...current, name } : current))
      await refreshSavedPlaylists()
    }, 'プレイリスト名を変更しました')
  }

  async function deleteSavedPlaylist() {
    if (!selectedSavedPlaylist) return
    if (!window.confirm(`「${selectedSavedPlaylist.name}」を削除しますか?`)) return
    await runAction(async () => {
      await api.deleteSavedPlaylist(selectedSavedPlaylist.id)
      setSelectedSavedPlaylist(null)
      await refreshSavedPlaylists()
    }, 'プレイリストを削除しました')
  }

  async function addTrackByUrl() {
    if (!selectedSavedPlaylist) return
    const url = trackUrl.trim()
    if (!url) return
    await runAction(async () => {
      const payload = await api.addSavedPlaylistTrack(selectedSavedPlaylist.id, { url })
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
      setTrackUrl('')
      await refreshSavedPlaylists()
    }, '曲を追加しました')
  }

  async function searchSavedPlaylistTracks() {
    if (!selectedSavedPlaylist) return
    const query = trackSearchQuery.trim()
    if (!query) return
    await runAction(async () => {
      const payload = await api.searchSavedPlaylistTrack(selectedSavedPlaylist.id, query)
      const results = typeof payload === 'object' && payload !== null && 'results' in payload && Array.isArray(payload.results)
        ? payload.results
        : []
      setTrackSearchResults(results)
    }, '候補を取得しました')
  }

  /** @param {import('../api/client.js').SavedPlaylistTrack} track */
  async function addTrackFromSearchResult(track) {
    if (!selectedSavedPlaylist) return
    await runAction(async () => {
      const payload = await api.addSavedPlaylistTrack(selectedSavedPlaylist.id, { track })
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
      await refreshSavedPlaylists()
    }, '曲を追加しました')
  }

  /** @param {number} trackId */
  async function removeSavedPlaylistTrack(trackId) {
    if (!selectedSavedPlaylist) return
    await runAction(async () => {
      const payload = await api.removeSavedPlaylistTrack(selectedSavedPlaylist.id, trackId)
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
      await refreshSavedPlaylists()
    }, '曲を削除しました')
  }

  /** @param {number} fromIndex @param {number} toIndex */
  async function moveSavedPlaylistTrack(fromIndex, toIndex) {
    if (!selectedSavedPlaylist) return
    await runAction(async () => {
      const payload = await api.moveSavedPlaylistTrack(selectedSavedPlaylist.id, fromIndex, toIndex)
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
    }, 'プレイリストを並べ替えました')
  }

  async function queueSavedPlaylist() {
    if (!selectedSavedPlaylist || !guildId) return
    await runAction(async () => {
      await api.queueSavedPlaylist(selectedSavedPlaylist.id, guildId)
    }, 'プレイリストをキューに追加しました')
  }

  return (
    <main className="dashboard-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">P</span>
          <div>
            <p className="eyebrow">Discord Music Bot</p>
            <h1>Music Dashboard</h1>
          </div>
        </div>
        <div className="header-meta">
          <span className="user-chip">
            <span className="user-avatar" aria-hidden="true">
              {(user?.username ?? user?.discordId ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="user-name">{user?.username ?? user?.discordId ?? 'ログイン確認中'}</span>
          </span>
          <button type="button" className="ghost-button" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <section className="guild-bar" aria-label="Guild selector">
        <label>
          <span>Guild ID</span>
          <input value={guildId} onChange={(event) => updateGuildId(event.target.value)} placeholder="Discord guild id" />
        </label>
        <button type="button" className="ghost-button" onClick={refreshState} disabled={!guildId || busy}>
          Refresh
        </button>
      </section>

      {message ? <p className="status-message" role="status">{message}</p> : null}

      <div className="dashboard-grid">
        <NowPlaying state={state} />
        <TransportControls busy={busy || !guildId} volume={volume} onAction={control} onVolumeChange={changeVolume} />
        <AutoplayPanel
          mode={autoplayMode}
          personalize={personalize}
          busy={busy || !guildId}
          onSetMode={setAutoplayModeAction}
          onSetPersonalize={setPersonalizeAction}
        />
        <QueueList queue={queue} busy={busy || !guildId} onMove={moveQueue} onRemove={removeQueue} />
        <PlaylistPanel
          links={links}
          playlists={playlists}
          selectedService={selectedService}
          selectedPlaylistId={selectedPlaylist?.id}
          busy={busy || !guildId}
          onSelectService={setSelectedService}
          onLoadPlaylists={loadPlaylists}
          onSelectPlaylist={setSelectedPlaylist}
          onImport={importPlaylist}
          onRelink={relink}
          onDisconnect={disconnect}
        />
        <MatchReview
          job={importJob}
          tracks={reviewTracks}
          searchQuery={searchQuery}
          busy={busy}
          onQueryChange={setSearchQuery}
          onSearch={searchReplacement}
          onReplace={replaceTrack}
        />
        <PlaylistBuilder
          playlists={savedPlaylists}
          selectedPlaylist={selectedSavedPlaylist}
          newPlaylistName={newPlaylistName}
          onNewPlaylistNameChange={setNewPlaylistName}
          onCreate={createSavedPlaylist}
          onSelect={selectSavedPlaylist}
          renameValue={renameValue}
          onRenameValueChange={setRenameValue}
          onRename={renameSavedPlaylist}
          onDelete={deleteSavedPlaylist}
          trackUrl={trackUrl}
          onTrackUrlChange={setTrackUrl}
          onAddByUrl={addTrackByUrl}
          trackSearchQuery={trackSearchQuery}
          onTrackSearchQueryChange={setTrackSearchQuery}
          onSearchTracks={searchSavedPlaylistTracks}
          searchResults={trackSearchResults}
          onAddFromSearchResult={addTrackFromSearchResult}
          onMoveTrack={moveSavedPlaylistTrack}
          onRemoveTrack={removeSavedPlaylistTrack}
          onQueueToGuild={queueSavedPlaylist}
          canQueue={Boolean(guildId)}
          busy={busy}
        />
      </div>
    </main>
  )
}
