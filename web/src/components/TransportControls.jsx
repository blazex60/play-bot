/** @param {{ busy: boolean, onAction: (action: string) => void }} props */
export function TransportControls(props) {
  const { busy, onAction } = props
  return (
    <section className="panel controls-panel" aria-labelledby="transport-title">
      <div className="section-heading">
        <p className="eyebrow">Transport</p>
        <h2 id="transport-title">操作</h2>
      </div>
      <div className="transport-dock">
        <button type="button" onClick={() => onAction('pause')} disabled={busy}>
          Pause
        </button>
        <button type="button" onClick={() => onAction('resume')} disabled={busy}>
          Resume
        </button>
        <button type="button" onClick={() => onAction('skip')} disabled={busy}>
          Skip
        </button>
        <button type="button" className="danger" onClick={() => onAction('stop')} disabled={busy}>
          Stop
        </button>
      </div>
    </section>
  )
}
