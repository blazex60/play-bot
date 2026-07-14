/**
 * @param {{
 *   job: import('../api/client.js').ImportJob | null,
 *   tracks: import('../api/client.js').ImportTrack[],
 *   searchQuery: string,
 *   busy: boolean,
 *   onQueryChange: (query: string) => void,
 *   onSearch: () => void,
 *   onReplace: (track: import('../api/client.js').ImportTrack) => void,
 * }} props
 */
export function MatchReview(props) {
  const { job, tracks, searchQuery, busy, onQueryChange, onSearch, onReplace } = props
  if (!job) return null

  return (
    <section className="panel review-panel" aria-labelledby="review-title">
      <div className="section-heading">
        <p className="eyebrow">Review</p>
        <h2 id="review-title">取り込み結果</h2>
      </div>
      <div className="job-summary" data-testid="import-summary">
        <span>job #{job.jobId}</span>
        <span>{job.status}</span>
        <span>{job.matchedCount ?? 0} matched</span>
        <span>{job.failedCount ?? 0} failed</span>
      </div>
      <label className="search-row">
        <span>再検索</span>
        <input value={searchQuery} onChange={(event) => onQueryChange(event.target.value)} placeholder="曲名 アーティスト" />
        <button type="button" onClick={onSearch} disabled={busy || !searchQuery.trim() || tracks.length === 0}>
          Search
        </button>
      </label>
      <ol className="review-list">
        {tracks.map((track) => (
          <li key={track.id}>
            <div>
              <p>{track.source_title}</p>
              <small>{track.matched_title ?? 'no match'} / {track.match_status}</small>
            </div>
            <button type="button" onClick={() => onReplace(track)} disabled={busy || !track.replacement}>
              Replace
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
