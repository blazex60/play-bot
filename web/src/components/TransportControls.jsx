/** @param {{ busy: boolean, volume: number, onAction: (action: string) => void, onVolumeChange: (level: number) => void }} props */
export function TransportControls(props) {
  const { busy, volume, onAction, onVolumeChange } = props
  return (
    <section className="panel controls-panel" aria-labelledby="transport-title">
      <div className="section-heading">
        <p className="eyebrow">Transport</p>
        <h2 id="transport-title">操作</h2>
      </div>
      <div className="control-grid">
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
      <label className="volume-control">
        <span>音量 {Math.round(volume * 100)}%</span>
        <input
          type="range"
          min="0"
          max="2"
          step="0.05"
          value={volume}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          disabled={busy}
        />
      </label>
    </section>
  )
}
