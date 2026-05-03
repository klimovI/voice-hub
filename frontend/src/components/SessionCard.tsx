import { useStore } from '../store/useStore';
import {
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneIcon,
  PhoneOffIcon,
} from './icons';

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
    if (joined) return;
    onJoin(displayName);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    onDisplayNameChange(e.target.value);
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="card-title">Комната</h2>
      </div>
      <form id="join-form" onSubmit={handleSubmit} className="grid gap-[14px]">
        <label className="block text-[12px] font-medium text-muted">
          Имя
          <input
            id="display-name"
            name="displayName"
            type="text"
            placeholder="например, Илья"
            autoComplete="off"
            value={displayName}
            onChange={handleNameChange}
            className="input-field"
          />
        </label>
        <div className="flex items-center justify-center gap-3">
          <button
            id="join-button"
            type="submit"
            disabled={joining || joined || !configReady}
            title={configReady ? 'Войти в комнату' : 'Загрузка…'}
            aria-label={configReady ? 'Войти в комнату' : 'Загрузка…'}
            className="btn btn-primary justify-center p-0! w-12 h-12 rounded-full"
          >
            <PhoneIcon />
          </button>
          <button
            id="self-mute-button"
            type="button"
            aria-pressed={selfMuted}
            aria-label={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
            title={selfMuted ? 'Включить микрофон' : 'Выключить микрофон'}
            onClick={onToggleSelfMute}
            className={`btn justify-center p-0! w-12 h-12 rounded-full ${selfMuted ? 'btn-toggle-on' : 'btn-secondary'}`}
          >
            {selfMuted ? <MicOffIcon /> : <MicIcon />}
          </button>
          <button
            id="deafen-button"
            type="button"
            aria-pressed={deafened}
            aria-label={deafened ? 'Слушать всех' : 'Заглушить всех'}
            title={deafened ? 'Слушать всех' : 'Заглушить всех'}
            onClick={onToggleDeafen}
            className={`btn justify-center p-0! w-12 h-12 rounded-full ${deafened ? 'btn-toggle-on' : 'btn-secondary'}`}
          >
            {deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
          </button>
          <button
            id="leave-button"
            type="button"
            disabled={!joined}
            onClick={onLeave}
            title="Выйти"
            aria-label="Выйти"
            className="btn btn-danger justify-center p-0! w-12 h-12 rounded-full"
          >
            <PhoneOffIcon />
          </button>
        </div>
      </form>
    </section>
  );
}
