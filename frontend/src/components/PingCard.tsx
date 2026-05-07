import { useStore } from '../store/useStore';

type Props = {
  onPing: () => void;
};

function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className="vh-toggle"
      data-checked={checked}
    >
      <span className="vh-toggle-dot" />
    </button>
  );
}

export function PingCard({ onPing }: Props) {
  const joinState = useStore((s) => s.joinState);
  const lastPingSentAt = useStore((s) => s.lastPingSentAt);
  const pingSoundEnabled = useStore((s) => s.pingSoundEnabled);
  const muteIncomingPings = useStore((s) => s.muteIncomingPings);
  const setPingSoundEnabled = useStore((s) => s.setPingSoundEnabled);
  const setMuteIncomingPings = useStore((s) => s.setMuteIncomingPings);

  const hasConnection = joinState === 'joined' || joinState === 'idle';
  const coolingDown = Date.now() - lastPingSentAt < 10000;
  const disabled = !hasConnection || coolingDown;

  const tile =
    'w-full flex items-center p-6 transition-colors duration-150 bg-bg-0 border border-accent text-accent hover:bg-[rgba(75,226,119,0.08)]';

  return (
    <section className="card grid gap-5 p-6">
      <h2 className="card-title">Пинг</h2>

      <button
        id="ping-button"
        type="button"
        disabled={disabled}
        aria-label="Пингануть всех"
        onClick={onPing}
        className={`${tile} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span className="msym shrink-0" style={{ fontSize: 32 }}>
          notifications
        </span>
        <span className="flex-1 text-center text-[14px] font-bold uppercase tracking-[0.18em]">
          Пингануть
        </span>
      </button>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="section-label">Звук пинга</span>
          <Toggle
            checked={pingSoundEnabled}
            onChange={() => setPingSoundEnabled(!pingSoundEnabled)}
            ariaLabel="Звук пинга"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="section-label">Не показывать пинги</span>
          <Toggle
            checked={muteIncomingPings}
            onChange={() => setMuteIncomingPings(!muteIncomingPings)}
            ariaLabel="Не показывать пинги"
          />
        </div>
      </div>
    </section>
  );
}
