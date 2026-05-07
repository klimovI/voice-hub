import { useStore } from '../store/useStore';

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

export function PingCard() {
  const pingSoundEnabled = useStore((s) => s.pingSoundEnabled);
  const muteIncomingPings = useStore((s) => s.muteIncomingPings);
  const pingWindowFlashEnabled = useStore((s) => s.pingWindowFlashEnabled);
  const setPingSoundEnabled = useStore((s) => s.setPingSoundEnabled);
  const setMuteIncomingPings = useStore((s) => s.setMuteIncomingPings);
  const setPingWindowFlashEnabled = useStore((s) => s.setPingWindowFlashEnabled);

  const pingsVisible = !muteIncomingPings;

  return (
    <section className="card grid gap-5 p-6">
      <h2 className="card-title">Пинг</h2>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="section-label">Показывать пинги</span>
          <Toggle
            checked={pingsVisible}
            onChange={() => setMuteIncomingPings(!muteIncomingPings)}
            ariaLabel="Показывать пинги"
          />
        </div>

        {pingsVisible && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="section-label">Звук</span>
              <Toggle
                checked={pingSoundEnabled}
                onChange={() => setPingSoundEnabled(!pingSoundEnabled)}
                ariaLabel="Звук пинга"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="section-label">Мигание окна</span>
              <Toggle
                checked={pingWindowFlashEnabled}
                onChange={() => setPingWindowFlashEnabled(!pingWindowFlashEnabled)}
                ariaLabel="Мигание окна"
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
