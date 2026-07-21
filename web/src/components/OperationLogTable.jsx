/** @type {Record<string, string>} */
const SOURCE_LABELS = { command: 'コマンド', control: 'ダッシュボード操作', admin: '管理設定' }

/** @param {number} unixSeconds */
function formatTimestamp(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleString('ja-JP')
}

/**
 * @param {{
 *   logs: import('../api/client.js').OperationLogEntry[],
 *   busy: boolean,
 *   hasMore: boolean,
 *   onLoadMore: () => void,
 * }} props
 */
export function OperationLogTable(props) {
  const { logs, busy, hasMore, onLoadMore } = props
  return (
    <section className="panel admin-panel" aria-labelledby="operation-log-title">
      <div className="section-heading">
        <p className="eyebrow">Operation Log</p>
        <h2 id="operation-log-title">操作ログ</h2>
      </div>
      {logs.length === 0 ? (
        <p className="empty-copy">まだ操作ログはありません。</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">日時</th>
                <th scope="col">ユーザー</th>
                <th scope="col">種別</th>
                <th scope="col">アクション</th>
                <th scope="col">結果</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatTimestamp(log.createdAt)}</td>
                  <td>{log.username ?? log.discordUserId ?? '-'}</td>
                  <td>{SOURCE_LABELS[log.source] ?? log.source}</td>
                  <td>{log.action}</td>
                  <td>
                    <span className={log.success ? 'log-badge log-badge-success' : 'log-badge log-badge-fail'}>
                      {log.success ? '成功' : '失敗'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore ? (
        <button type="button" className="ghost-button" onClick={onLoadMore} disabled={busy}>
          もっと読み込む
        </button>
      ) : null}
    </section>
  )
}
