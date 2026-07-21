/**
 * @param {{
 *   commands: string[],
 *   visibility: Record<string, string>,
 *   busy: boolean,
 *   onChange: (command: string, value: 'public'|'personal') => void,
 * }} props
 */
export function VisibilityPanel(props) {
  const { commands, visibility, busy, onChange } = props
  return (
    <section className="panel admin-panel" aria-labelledby="visibility-panel-title">
      <div className="section-heading">
        <p className="eyebrow">Reply Visibility</p>
        <h2 id="visibility-panel-title">コマンド実行結果の表示設定</h2>
      </div>
      <p className="empty-copy">
        コマンドの実行結果を、そのチャンネルの全員に表示する(全体表示)か、実行した本人だけに表示する(個人表示)かをコマンドごとに設定します。
      </p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">コマンド</th>
              <th scope="col">表示設定</th>
            </tr>
          </thead>
          <tbody>
            {commands.map((command) => (
              <tr key={command}>
                <th scope="row">{command}</th>
                <td>
                  <select
                    value={visibility[command] ?? 'public'}
                    disabled={busy}
                    onChange={(event) => onChange(command, /** @type {'public'|'personal'} */ (event.target.value))}
                  >
                    <option value="public">全体表示</option>
                    <option value="personal">個人表示</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
