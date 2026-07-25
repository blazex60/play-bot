import { useCallback, useState } from 'react'
import { api } from '../api/client.js'

/**
 * Owns the "My Playlists" (saved playlist) feature's state and handlers, so
 * Dashboard.jsx doesn't have to. `runAction` is the page's shared busy/message
 * wrapper (see usePageActions) — passed in rather than imported here so this
 * hook composes with whatever follow-up (e.g. Dashboard's own refreshState())
 * the caller's runAction already layers on top.
 * @param {{ guildId: string, runAction: (work: () => Promise<void>, successMessage: string) => Promise<void> }} params
 */
export function useSavedPlaylists({ guildId, runAction }) {
  const [playlists, setPlaylists] = useState(/** @type {import('../api/client.js').SavedPlaylist[]} */ ([]))
  const [selectedPlaylist, setSelectedPlaylist] = useState(
    /** @type {import('../api/client.js').SavedPlaylist | null} */ (null)
  )
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [trackUrl, setTrackUrl] = useState('')
  const [trackSearchQuery, setTrackSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(
    /** @type {import('../api/client.js').SavedPlaylistTrack[]} */ ([])
  )

  // Stable across renders (unlike the rest of this hook's returned actions)
  // so callers can safely put it in a useEffect dependency array — e.g.
  // Dashboard's mount effect that fetches it once alongside api.me()/links().
  const refresh = useCallback(async () => {
    const payload = await api.mySavedPlaylists()
    if (typeof payload === 'object' && payload !== null && 'playlists' in payload && Array.isArray(payload.playlists)) {
      setPlaylists(payload.playlists)
    }
  }, [])

  /** @param {unknown} tracks */
  function updateSelectedTracks(tracks) {
    if (!Array.isArray(tracks)) return
    setSelectedPlaylist((current) => (current ? { ...current, tracks } : current))
  }

  async function create() {
    const name = newPlaylistName.trim()
    if (!name) return
    await runAction(async () => {
      await api.createSavedPlaylist(name)
      setNewPlaylistName('')
      await refresh()
    }, 'プレイリストを作成しました')
  }

  /** @param {import('../api/client.js').SavedPlaylist} playlist */
  async function select(playlist) {
    await runAction(async () => {
      const detail = /** @type {import('../api/client.js').SavedPlaylist} */ (await api.savedPlaylist(playlist.id))
      setSelectedPlaylist(detail)
      setRenameValue(detail.name)
      setSearchResults([])
    }, 'プレイリストを読み込みました')
  }

  async function rename() {
    if (!selectedPlaylist) return
    const name = renameValue.trim()
    if (!name) return
    await runAction(async () => {
      await api.renameSavedPlaylist(selectedPlaylist.id, name)
      setSelectedPlaylist((current) => (current ? { ...current, name } : current))
      await refresh()
    }, 'プレイリスト名を変更しました')
  }

  async function remove() {
    if (!selectedPlaylist) return
    if (!window.confirm(`「${selectedPlaylist.name}」を削除しますか?`)) return
    await runAction(async () => {
      await api.deleteSavedPlaylist(selectedPlaylist.id)
      setSelectedPlaylist(null)
      await refresh()
    }, 'プレイリストを削除しました')
  }

  async function addByUrl() {
    if (!selectedPlaylist) return
    const url = trackUrl.trim()
    if (!url) return
    await runAction(async () => {
      const payload = await api.addSavedPlaylistTrack(selectedPlaylist.id, { url })
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
      setTrackUrl('')
      await refresh()
    }, '曲を追加しました')
  }

  async function searchTracks() {
    if (!selectedPlaylist) return
    const query = trackSearchQuery.trim()
    if (!query) return
    await runAction(async () => {
      const payload = await api.searchSavedPlaylistTrack(selectedPlaylist.id, query)
      const results = typeof payload === 'object' && payload !== null && 'results' in payload && Array.isArray(payload.results)
        ? payload.results
        : []
      setSearchResults(results)
    }, '候補を取得しました')
  }

  /** @param {import('../api/client.js').SavedPlaylistTrack} track */
  async function addFromSearchResult(track) {
    if (!selectedPlaylist) return
    await runAction(async () => {
      const payload = await api.addSavedPlaylistTrack(selectedPlaylist.id, { track })
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
      await refresh()
    }, '曲を追加しました')
  }

  /** @param {number} trackId */
  async function removeTrack(trackId) {
    if (!selectedPlaylist) return
    await runAction(async () => {
      const payload = await api.removeSavedPlaylistTrack(selectedPlaylist.id, trackId)
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
      await refresh()
    }, '曲を削除しました')
  }

  /** @param {number} fromIndex @param {number} toIndex */
  async function moveTrack(fromIndex, toIndex) {
    if (!selectedPlaylist) return
    await runAction(async () => {
      const payload = await api.moveSavedPlaylistTrack(selectedPlaylist.id, fromIndex, toIndex)
      updateSelectedTracks(/** @type {{ tracks?: unknown }} */ (payload)?.tracks)
    }, 'プレイリストを並べ替えました')
  }

  async function queueToGuild() {
    if (!selectedPlaylist || !guildId) return
    await runAction(async () => {
      await api.queueSavedPlaylist(selectedPlaylist.id, guildId)
    }, 'プレイリストをキューに追加しました')
  }

  return {
    state: {
      playlists,
      selectedPlaylist,
      newPlaylistName,
      renameValue,
      trackUrl,
      trackSearchQuery,
      searchResults,
      canQueue: Boolean(guildId),
    },
    actions: {
      refresh,
      onNewPlaylistNameChange: setNewPlaylistName,
      onCreate: create,
      onSelect: select,
      onRenameValueChange: setRenameValue,
      onRename: rename,
      onDelete: remove,
      onTrackUrlChange: setTrackUrl,
      onAddByUrl: addByUrl,
      onTrackSearchQueryChange: setTrackSearchQuery,
      onSearchTracks: searchTracks,
      onAddFromSearchResult: addFromSearchResult,
      onMoveTrack: moveTrack,
      onRemoveTrack: removeTrack,
      onQueueToGuild: queueToGuild,
    },
  }
}
