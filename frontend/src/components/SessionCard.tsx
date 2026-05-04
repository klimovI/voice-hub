import { useStore } from '../store/useStore';

interface Props {
  onJoin: (displayName: string) => void;
  onLeave: () => void;
  onToggleSelfMute: () => void;
  onToggleDeafen: () => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
}

export function SessionCard({
  onJoin,
  onLeave,
  onToggleSelfMute,
  onToggleDeafen,
  displayName,
  onDisplayNameChange,
}: Props) {
  const joinState = useStore((s) => s.joinState);
  const selfMuted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.deafened);
  const configReady = useStore((s) => s.configReady);

  const joining = joinState === 'joining';
  const joined = joinState === 'joined';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (joined) {
      onLeave();
      return;
    }
    onJoin(displayName);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    onDisplayNameChange(e.target.value);
  }

  const micOn = !selfMuted;
  const earOn = !deafened;

  let heroLabel: string;
  let heroIcon: string;
  if (joined) {
    heroLabel = 'Отключиться';
    heroIcon = 'sensors_off';
  } else if (joining) {
    heroLabel = 'Подключение…';
    heroIcon = 'sensors';
  } else {
    heroLabel = 'Подключиться';
    heroIcon = 'sensors';
  }

  // Flat bordered button per base.html: border-accent + text-accent when active,
  // border-danger + text-danger when off. Outline icons (no msym-fill) per image.png.
  const tileOn = 'bg-bg-0 border border-accent text-accent hover:bg-[rgba(75,226,119,0.08)]';
  const tileOff = 'bg-bg-0 border border-danger text-danger hover:bg-[rgba(248,113,113,0.08)]';

  return (
    <section className="card grid gap-5 p-6">
      <h2 className="card-title">Комната</h2>

      <div className="grid gap-3">
        <div className="grid gap-2">
          <label htmlFor="display-name" className="section-label">
            Имя
          </label>
          <input
            id="display-name"
            name="displayName"
            type="text"
            placeholder="ИМЯ"
            autoComplete="off"
            value={displayName}
            onChange={handleNameChange}
            className="w-full bg-bg-0 border border-line px-4 py-3
            text-accent text-[22px] leading-[28px] font-bold tracking-[0.2em]
            transition-colors duration-150
            placeholder:text-muted-2
            focus:outline-none focus:border-accent"
          />
        </div>

        <form id="join-form" onSubmit={handleSubmit} className="grid gap-3">
          <div className="flex gap-2">
            <button
              id="self-mute-button"
              type="button"
              aria-pressed={selfMuted}
              aria-label={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
              title={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
              onClick={onToggleSelfMute}
              className={`flex-1 flex items-center p-4 transition-colors duration-150 ${
                micOn ? tileOn : tileOff
              }`}
            >
              <span className="msym shrink-0" style={{ fontSize: 24 }}>
                mic
              </span>
              <span className="flex-1 text-center text-[14px] font-bold uppercase tracking-[0.18em]">
                {micOn ? 'Микро' : 'Выкл'}
              </span>
            </button>
            <button
              id="deafen-button"
              type="button"
              aria-pressed={deafened}
              aria-label={deafened ? 'Слушать всех' : 'Заглушить всех'}
              title={deafened ? 'Слушать всех' : 'Заглушить всех'}
              onClick={onToggleDeafen}
              className={`flex-1 flex items-center p-4 transition-colors duration-150 ${
                earOn ? tileOn : tileOff
              }`}
            >
              <span className="msym shrink-0" style={{ fontSize: 24 }}>
                volume_up
              </span>
              <span className="flex-1 text-center text-[14px] font-bold uppercase tracking-[0.18em]">
                {earOn ? 'Звук' : 'Тихо'}
              </span>
            </button>
          </div>

          <button
            id="join-button"
            type="submit"
            disabled={joining || (!joined && !configReady)}
            className={`btn btn-hero ${joined ? 'btn-danger' : 'btn-primary'}`}
          >
            <span className="msym shrink-0" style={{ fontSize: 32 }}>
              {heroIcon}
            </span>
            <span className="flex-1 text-center">{heroLabel}</span>
          </button>
        </form>
      </div>
    </section>
  );
}
