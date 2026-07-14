const SERVICES = [
  { id: 'spotify', label: 'Spotify' },
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
  } = props
  const selectedLink = links.find((link) => link.service === selectedService)
  const needsRelink = selectedLink?.status === 'needs_relink'

  return (
    <section className="panel playlist-panel" aria-labelledby="playlist-title">
      <div className="section-heading">
        <p className="eyebrow">Playlists</p>
        <h2 id="playlist-title">プレイリスト取り込み</h2>
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
        <button type="button" disabled aria-disabled="true" className="disabled-service">
          Apple Music
          <span>準備中</span>
        </button>
      </div>
      {needsRelink ? (
        <div className="inline-warning">
          <p>{selectedService} の認証が切れています。</p>
          <button type="button" onClick={() => onRelink(selectedService)} disabled={busy}>
            再連携
          </button>
        </div>
      ) : null}
      <div className="playlist-actions">
        <button type="button" onClick={() => onLoadPlaylists(selectedService)} disabled={busy || needsRelink}>
          プレイリストを取得
        </button>
        <button type="button" className="primary" onClick={onImport} disabled={busy || !selectedPlaylistId || needsRelink}>
          キューに追加
        </button>
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
