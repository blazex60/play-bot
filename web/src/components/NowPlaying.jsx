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
  return (
    <section className="panel now-playing" aria-labelledby="now-playing-title">
      <div className="section-heading">
        <p className="eyebrow">Now Playing</p>
        <h2 id="now-playing-title">現在の曲</h2>
      </div>
      {track ? (
        <div className="track-hero">
          {track.thumbnail ? <img src={track.thumbnail} alt="" width="96" height="96" /> : <div className="art-fallback" />}
          <div>
            <p className="track-title">{track.title}</p>
            <a href={track.webpageUrl} target="_blank" rel="noreferrer">
              YouTube で開く
            </a>
            <dl className="state-grid">
              <div>
                <dt>状態</dt>
                <dd>{statusLabel(state.playerStatus)}</dd>
              </div>
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
