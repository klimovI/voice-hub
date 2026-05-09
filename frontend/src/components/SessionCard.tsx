import { useStore } from '../store/useStore';
import { ROOM_SLUGS, ROOM_LABELS, type RoomSlug } from '../rooms';
import { useRoomPeers } from '../hooks/useRoomPeers';

interface Props {
  onJoin: (displayName: string) => void;
  onLeave: () => void;
  onRoomSelect: (slug: RoomSlug) => void;
  onToggleSelfMute: () => void;
  onToggleDeafen: () => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
}

export function SessionCard({
  onJoin,
  onLeave,
  onRoomSelect,
  onToggleSelfMute,
  onToggleDeafen,
  displayName,
  onDisplayNameChange,
}: Props) {
  const joinState = useStore((s) => s.joinState);
  const selfMuted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.deafened);
  const configReady = useStore((s) => s.configReady);
  const roomSlug = useStore((s) => s.roomSlug);

  const roomPeers = useRoomPeers();

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
        <div className="grid gap-1.5">
          {ROOM_SLUGS.map((slug: RoomSlug) => {
            const active = slug === roomSlug;
            const peers = roomPeers[slug];
            const count = peers.length;
            const nameLine = count > 0 ? peers.map((p) => p.displayName).join(', ') : null;

            // joining: block all clicks (too racy)
            // joined + current: no-op click, cursor-default
            // joined + other: switchable target
            // idle: free selection
            const isJoining = joinState === 'joining';
            const isJoined = joinState === 'joined';
            const switchable = isJoined && !active;
            const clickable = !isJoining && (!isJoined || switchable);

            let title: string | undefined;
            if (isJoining) title = 'Подождите…';
            else if (switchable) title = 'Перейти в эту комнату';

            return (
              <button
                key={slug}
                type="button"
                onClick={clickable ? () => onRoomSelect(slug) : undefined}
                title={title}
                className={`flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 ${
                  active
                    ? tileOn
                    : switchable
                      ? 'bg-bg-0 border border-line text-muted hover:border-line-strong hover:border-accent/50'
                      : 'bg-bg-0 border border-line text-muted hover:border-line-strong'
                } ${isJoining ? 'opacity-50 cursor-not-allowed' : active && isJoined ? 'cursor-default' : 'cursor-pointer'}`}
              >
                <span className="text-[13px] font-bold uppercase tracking-[0.15em] shrink-0">
                  {ROOM_LABELS[slug]}
                </span>
                <span
                  className={`text-[12px] tabular-nums tracking-[0.1em] px-2 py-0.5 border shrink-0 ${
                    count > 0 ? 'border-accent text-accent' : 'border-line text-muted-2'
                  }`}
                >
                  {count}
                </span>
                {nameLine && (
                  <span className="flex-1 min-w-0 text-left text-muted-2 text-[11px] tracking-[0.05em] truncate">
                    {nameLine}
                  </span>
                )}
              </button>
            );
          })}
        </div>

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
            text-accent text-[20px] leading-[28px] font-bold tracking-[0.2em]
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
                {earOn ? 'Звук' : 'Выкл'}
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
