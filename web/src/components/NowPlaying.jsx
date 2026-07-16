/** @param {string | undefined | null} status */
function statusLabel(status) {
  if (status === 'playing') return '再生中'
  if (status === 'paused') return '一時停止'
  if (status === 'idle') return '待機中'
  return status ?? '不明'
}

/** @param {{ state: import('../api/client.js').PlaybackState }} props */
export function NowPlaying(props) {
  const { state } = props
  const track = state?.current
  const status = state?.playerStatus ?? 'idle'
  return (
    <section className="panel now-playing" aria-labelledby="now-playing-title">
      <div className="section-heading">
        <p className="eyebrow">Now Playing</p>
        <h2 id="now-playing-title">現在の曲</h2>
      </div>
      <div className={`vc-status-chip status-${status}`}>
        <span className="status-dot" aria-hidden="true" />
        {statusLabel(status)}
      </div>
      {track ? (
        <div className="track-hero">
          <div className={`art-wrap${status === 'playing' ? ' is-live' : ''}`}>
            {track.thumbnail ? <img src={track.thumbnail} alt="" width="108" height="108" /> : <div className="art-fallback" />}
          </div>
          <div>
            <p className="track-title">{track.title}</p>
            <a href={track.webpageUrl} target="_blank" rel="noreferrer">
              YouTube で開く
            </a>
            <dl className="state-grid">
              <div>
                <dt>ループ</dt>
                <dd>{state.loopMode ?? 'OFF'}</dd>
              </div>
            </dl>
          </div>
        </div>
      ) : (
        <p className="empty-copy">まだ再生中の曲はありません。</p>
      )}
    </section>
  )
}
