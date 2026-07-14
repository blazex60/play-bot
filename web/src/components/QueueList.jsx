/** @param {{ queue: import('../api/client.js').Track[], busy: boolean, onMove: (fromIndex: number, toIndex: number) => void, onRemove: (index: number) => void }} props */
export function QueueList(props) {
  const { queue, busy, onMove, onRemove } = props
  return (
    <section className="panel queue-panel" aria-labelledby="queue-title">
      <div className="section-heading">
        <p className="eyebrow">Queue</p>
        <h2 id="queue-title">キュー</h2>
      </div>
      {queue.length === 0 ? (
        <p className="empty-copy">次の曲はありません。</p>
      ) : (
        <ol className="queue-list">
          {queue.map((track, index) => (
            <li key={`${track.webpageUrl ?? track.title}-${index}`} className="queue-item">
              <span className="queue-index">{index + 1}</span>
              <div>
                <p>{track.title}</p>
                {track.requestedBy ? <small>requested by {track.requestedBy}</small> : null}
              </div>
              <div className="queue-actions">
                <button type="button" onClick={() => onMove(index, index - 1)} disabled={busy || index === 0}>
                  Up
                </button>
                <button type="button" onClick={() => onMove(index, index + 1)} disabled={busy || index === queue.length - 1}>
                  Down
                </button>
                <button type="button" className="ghost-danger" onClick={() => onRemove(index)} disabled={busy}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
