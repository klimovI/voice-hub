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
      className={`relative w-10 h-6 rounded-full transition-colors duration-150 shrink-0 ${
        checked ? 'bg-accent' : 'bg-line'
      }`}
    >
      <span
        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform duration-150 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
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

  return (
    <section className="card grid gap-4 p-6">
      <h2 className="card-title">Пинг</h2>

      <button
        id="ping-button"
        type="button"
        disabled={disabled}
        aria-label="Пингануть всех"
        onClick={onPing}
        className={`btn ${disabled ? 'btn-secondary opacity-50 cursor-not-allowed' : 'btn-primary'}`}
      >
        <span className="msym shrink-0" style={{ fontSize: 20 }}>
          notifications
        </span>
        <span className="flex-1 text-center">Пингануть всех</span>
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
