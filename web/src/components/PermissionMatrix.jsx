import { useState } from 'react'

const DEFAULT_VALUES = ['allow', 'deny']
const OVERRIDE_VALUES = ['inherit', 'allow', 'deny']

/**
 * @param {{
 *   commands: string[],
 *   defaults: Record<string, string>,
 *   overrides: Record<string, Record<string, string>>,
 *   knownUsers: import('../api/client.js').KnownUser[],
 *   busy: boolean,
 *   onSetDefault: (command: string, value: 'allow'|'deny') => void,
 *   onSetUserOverride: (userId: string, command: string, value: 'allow'|'deny'|null) => void,
 * }} props
 */
export function PermissionMatrix(props) {
  const { commands, defaults, overrides, knownUsers, busy, onSetDefault, onSetUserOverride } = props
  const overrideUserIds = Object.keys(overrides)
  // Rows added but not yet given any per-command override: shown as all
  // "inherit" until the admin actually picks a value for some command.
  // Persisting an 'allow' for an arbitrary command the moment a row is
  // added would silently grant that command even when the admin only
  // meant to configure a different one for this user.
  const [pendingUserIds, setPendingUserIds] = useState(/** @type {string[]} */ ([]))
  const displayedUserIds = [...new Set([...overrideUserIds, ...pendingUserIds])]
  const addableUsers = knownUsers.filter((user) => !displayedUserIds.includes(user.discordId))

  /** @param {string} discordId */
  function addUserRow(discordId) {
    if (!discordId || displayedUserIds.includes(discordId)) return
    setPendingUserIds((ids) => [...ids, discordId])
  }

  return (
    <section className="panel admin-panel" aria-labelledby="permission-matrix-title">
      <div className="section-heading">
        <p className="eyebrow">Command Permissions</p>
        <h2 id="permission-matrix-title">コマンド権限</h2>
      </div>
      <p className="empty-copy">
        「デフォルト」はこのサーバーの全ユーザーに適用される既定値です。ユーザーごとの行では「継承」でデフォルトに従い、許可/拒否で個別に上書きできます。
      </p>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">ユーザー</th>
              {commands.map((command) => (
                <th scope="col" key={command}>{command}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">デフォルト</th>
              {commands.map((command) => (
                <td key={command}>
                  <select
                    value={defaults[command] ?? 'allow'}
                    disabled={busy}
                    onChange={(event) => onSetDefault(command, /** @type {'allow'|'deny'} */ (event.target.value))}
                  >
                    {DEFAULT_VALUES.map((value) => (
                      <option key={value} value={value}>{value === 'allow' ? '許可' : '拒否'}</option>
                    ))}
                  </select>
                </td>
              ))}
            </tr>
            {displayedUserIds.map((userId) => {
              const known = knownUsers.find((user) => user.discordId === userId)
              return (
                <tr key={userId}>
                  <th scope="row">{known?.username ?? userId}</th>
                  {commands.map((command) => {
                    const value = overrides[userId]?.[command] ?? 'inherit'
                    return (
                      <td key={command}>
                        <select
                          value={value}
                          disabled={busy}
                          onChange={(event) => {
                            const next = event.target.value
                            onSetUserOverride(userId, command, next === 'inherit' ? null : /** @type {'allow'|'deny'} */ (next))
                          }}
                        >
                          {OVERRIDE_VALUES.map((v) => (
                            <option key={v} value={v}>{v === 'inherit' ? '継承' : v === 'allow' ? '許可' : '拒否'}</option>
                          ))}
                        </select>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="admin-add-user">
        <label>
          <span>ユーザーを追加</span>
          <select disabled={busy || addableUsers.length === 0} onChange={(event) => addUserRow(event.target.value)} value="">
            <option value="" disabled>選択してください</option>
            {addableUsers.map((user) => (
              <option key={user.discordId} value={user.discordId}>{user.username}</option>
            ))}
          </select>
        </label>
        <AddByIdForm busy={busy} onAdd={addUserRow} />
      </div>
    </section>
  )
}

/** @param {{ busy: boolean, onAdd: (discordId: string) => void }} props */
function AddByIdForm({ busy, onAdd }) {
  /** @param {import('react').FormEvent<HTMLFormElement>} event */
  function handleSubmit(event) {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem('discordId')
    const value = input instanceof HTMLInputElement ? input.value.trim() : ''
    if (!value) return
    onAdd(value)
    if (input instanceof HTMLInputElement) input.value = ''
  }

  return (
    <form onSubmit={handleSubmit}>
      <label>
        <span>Discord User IDで追加</span>
        <input name="discordId" placeholder="123456789012345678" disabled={busy} />
      </label>
      <button type="submit" className="ghost-button" disabled={busy}>追加</button>
    </form>
  )
}
