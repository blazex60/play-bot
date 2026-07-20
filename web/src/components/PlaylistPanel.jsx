const SERVICES = [
  { id: 'youtube', label: 'YouTube' },
]

/**
 * @param {{
 *   links: import('../api/client.js').ServiceLink[],
 *   playlists: import('../api/client.js').Playlist[],
 *   selectedService: string,
 *   selectedPlaylistId?: string | undefined,
 *   busy: boolean,
 *   onSelectService: (service: string) => void,
 *   onLoadPlaylists: (service: string) => void,
 *   onSelectPlaylist: (playlist: import('../api/client.js').Playlist) => void,
 *   onImport: () => void,
 *   onRelink: (service: string) => void,
 *   onDisconnect: (service: string) => void,
 * }} props
 */
export function PlaylistPanel(props) {
  const {
    links,
    playlists,
    selectedService,
    selectedPlaylistId,
    busy,
    onSelectService,
    onLoadPlaylists,
    onSelectPlaylist,
    onImport,
    onRelink,
    onDisconnect,
  } = props
  const selectedLink = links.find((link) => link.service === selectedService)
  const isLinked = selectedLink?.status === 'active'
  const needsRelink = selectedLink?.status === 'needs_relink'

  return (
    <section className="panel playlist-panel" aria-labelledby="playlist-title">
      <div className="section-heading">
        <p className="eyebrow">Playlists</p>
        <h2 id="playlist-title">【BETA】プレイリスト取り込み</h2>
      </div>
      <div className="service-tabs" role="tablist" aria-label="連携サービス">
        {SERVICES.map((service) => {
          const link = links.find((item) => item.service === service.id)
          return (
            <button
              key={service.id}
              type="button"
              role="tab"
              aria-selected={selectedService === service.id}
              className={selectedService === service.id ? 'selected' : ''}
              onClick={() => onSelectService(service.id)}
            >
              {service.label}
              <span>{link?.status === 'active' ? '連携済み' : link?.status === 'needs_relink' ? '再連携' : '未連携'}</span>
            </button>
          )
        })}
      </div>
      {!isLinked ? (
        <div className="inline-warning">
          <p>{needsRelink ? `${selectedService} の認証が切れています。` : `${selectedService} と連携していません。`}</p>
          <button type="button" onClick={() => onRelink(selectedService)} disabled={busy}>
            {needsRelink ? '再連携' : '連携する'}
          </button>
        </div>
      ) : null}
      <div className="playlist-actions">
        <button type="button" onClick={() => onLoadPlaylists(selectedService)} disabled={busy || !isLinked}>
          プレイリストを取得
        </button>
        <button type="button" className="primary" onClick={onImport} disabled={busy || !selectedPlaylistId || !isLinked}>
          キューに追加
        </button>
        {isLinked ? (
          <button type="button" className="ghost-danger" onClick={() => onDisconnect(selectedService)} disabled={busy}>
            連携解除
          </button>
        ) : null}
      </div>
      <div className="playlist-list" role="listbox" aria-label="プレイリスト">
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            role="option"
            aria-selected={selectedPlaylistId === playlist.id}
            className={selectedPlaylistId === playlist.id ? 'selected' : ''}
            onClick={() => onSelectPlaylist(playlist)}
          >
            <strong>{playlist.name}</strong>
            <span>{playlist.trackCount ?? playlist.tracks?.total ?? '?'} tracks</span>
          </button>
        ))}
      </div>
    </section>
  )
}
