const MODES = [
  { value: 'off', label: 'オフ' },
  { value: 'auto', label: '自動' },
  { value: 'recommend', label: 'おすすめ' },
]

/** @param {{ mode: string, personalize: boolean, busy: boolean, onSetMode: (mode: string) => void, onSetPersonalize: (enabled: boolean) => void }} props */
export function AutoplayPanel(props) {
  const { mode, personalize, busy, onSetMode, onSetPersonalize } = props
  return (
    <section className="panel autoplay-panel" aria-labelledby="autoplay-title">
      <div className="section-heading">
        <p className="eyebrow">Autoplay</p>
        <h2 id="autoplay-title">自動再生</h2>
      </div>
      <div className="transport-dock" role="group" aria-label="自動再生モード">
        {MODES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={value === mode ? 'active' : undefined}
            aria-pressed={value === mode}
            onClick={() => onSetMode(value)}
            disabled={busy}
          >
            {label}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-pressed={personalize}
        onClick={() => onSetPersonalize(!personalize)}
        disabled={busy}
      >
        パーソナライズ: {personalize ? 'ON' : 'OFF'}
      </button>
    </section>
  )
}
