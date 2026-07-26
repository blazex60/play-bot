/**
 * @param {{
 *   state: {
 *     playlists: import('../api/client.js').SavedPlaylist[],
 *     selectedPlaylist: import('../api/client.js').SavedPlaylist | null,
 *     newPlaylistName: string,
 *     renameValue: string,
 *     trackUrl: string,
 *     trackSearchQuery: string,
 *     searchResults: import('../api/client.js').SavedPlaylistTrack[],
 *     canQueue: boolean,
 *     busy: boolean,
 *   },
 *   actions: {
 *     onNewPlaylistNameChange: (value: string) => void,
 *     onCreate: () => void,
 *     onSelect: (playlist: import('../api/client.js').SavedPlaylist) => void,
 *     onRenameValueChange: (value: string) => void,
 *     onRename: () => void,
 *     onDelete: () => void,
 *     onTrackUrlChange: (value: string) => void,
 *     onAddByUrl: () => void,
 *     onTrackSearchQueryChange: (value: string) => void,
 *     onSearchTracks: () => void,
 *     onAddFromSearchResult: (track: import('../api/client.js').SavedPlaylistTrack) => void,
 *     onMoveTrack: (fromIndex: number, toIndex: number) => void,
 *     onRemoveTrack: (trackId: number) => void,
 *     onQueueToGuild: () => void,
 *   },
 * }} props
 */
export function PlaylistBuilder({ state, actions }) {
  const {
    playlists,
    selectedPlaylist,
    newPlaylistName,
    renameValue,
    trackUrl,
    trackSearchQuery,
    searchResults,
    canQueue,
    busy,
  } = state
  const {
    onNewPlaylistNameChange,
    onCreate,
    onSelect,
    onRenameValueChange,
    onRename,
    onDelete,
    onTrackUrlChange,
    onAddByUrl,
    onTrackSearchQueryChange,
    onSearchTracks,
    onAddFromSearchResult,
    onMoveTrack,
    onRemoveTrack,
    onQueueToGuild,
  } = actions

  const tracks = selectedPlaylist?.tracks ?? []

  return (
    <section className="panel playlist-builder-panel" aria-labelledby="playlist-builder-title">
      <div className="section-heading">
        <p className="eyebrow">My Playlists</p>
        <h2 id="playlist-builder-title">マイプレイリスト</h2>
      </div>

      <form
        className="playlist-create-form"
        onSubmit={(event) => {
          event.preventDefault()
          onCreate()
        }}
      >
        <input
          value={newPlaylistName}
          onChange={(event) => onNewPlaylistNameChange(event.target.value)}
          placeholder="新しいプレイリスト名"
          aria-label="新しいプレイリスト名"
        />
        <button type="submit" disabled={busy || !newPlaylistName.trim()}>
          作成
        </button>
      </form>

      {playlists.length === 0 ? (
        <p className="empty-copy">プレイリストはまだありません。</p>
      ) : (
        <div className="playlist-list" role="listbox" aria-label="マイプレイリスト">
          {playlists.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              role="option"
              aria-selected={selectedPlaylist?.id === playlist.id}
              className={selectedPlaylist?.id === playlist.id ? 'selected' : ''}
              onClick={() => onSelect(playlist)}
            >
              <strong>{playlist.name}</strong>
              <span>{playlist.trackCount ?? 0} tracks</span>
            </button>
          ))}
        </div>
      )}

      {selectedPlaylist ? (
        <div className="playlist-detail">
          <form
            className="playlist-rename-form"
            onSubmit={(event) => {
              event.preventDefault()
              onRename()
            }}
          >
            <input
              value={renameValue}
              onChange={(event) => onRenameValueChange(event.target.value)}
              aria-label="プレイリスト名を変更"
            />
            <button type="submit" disabled={busy || !renameValue.trim()}>
              名前を変更
            </button>
            <button type="button" className="ghost-danger" onClick={onDelete} disabled={busy}>
              削除
            </button>
          </form>

          {tracks.length === 0 ? (
            <p className="empty-copy">曲がまだありません。</p>
          ) : (
            <ol className="queue-list">
              {tracks.map((track, index) => (
                <li key={track.id} className="queue-item">
                  <span className="queue-index">{index + 1}</span>
                  <div>
                    <p>{track.title}</p>
                  </div>
                  <div className="queue-actions">
                    <button type="button" onClick={() => onMoveTrack(index, index - 1)} disabled={busy || index === 0}>
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => onMoveTrack(index, index + 1)}
                      disabled={busy || index === tracks.length - 1}
                    >
                      Down
                    </button>
                    <button type="button" className="ghost-danger" onClick={() => onRemoveTrack(track.id)} disabled={busy}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <form
            className="playlist-track-url-form"
            onSubmit={(event) => {
              event.preventDefault()
              onAddByUrl()
            }}
          >
            <input
              value={trackUrl}
              onChange={(event) => onTrackUrlChange(event.target.value)}
              placeholder="YouTube の URL"
              aria-label="曲を追加する YouTube の URL"
            />
            <button type="submit" disabled={busy || !trackUrl.trim()}>
              追加
            </button>
          </form>

          <form
            className="playlist-track-search-form"
            onSubmit={(event) => {
              event.preventDefault()
              onSearchTracks()
            }}
          >
            <input
              value={trackSearchQuery}
              onChange={(event) => onTrackSearchQueryChange(event.target.value)}
              placeholder="曲名で検索"
              aria-label="曲名で検索"
            />
            <button type="submit" disabled={busy || !trackSearchQuery.trim()}>
              検索
            </button>
          </form>

          {searchResults.length > 0 ? (
            <ol className="playlist-search-results">
              {searchResults.map((result, index) => (
                <li key={`${result.videoId ?? result.webpageUrl}-${index}`}>
                  <span>{result.title}</span>
                  <button type="button" onClick={() => onAddFromSearchResult(result)} disabled={busy}>
                    追加
                  </button>
                </li>
              ))}
            </ol>
          ) : null}

          <button
            type="button"
            className="primary"
            onClick={onQueueToGuild}
            disabled={busy || !canQueue || tracks.length === 0}
          >
            このサーバーのキューに追加
          </button>
        </div>
      ) : null}
    </section>
  )
}
