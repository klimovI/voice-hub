import { Mic, ScreenShare, Volume2, Wifi, WifiOff, type LucideIcon } from 'lucide-react';
import { useStore } from '../store/useStore';
import { isTauri } from '../utils/tauri';

interface Props {
  onJoin: (displayName: string) => void;
  onLeave: () => void;
  onToggleSelfMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
}

export function SessionCard({
  onJoin,
  onLeave,
  onToggleSelfMute,
  onToggleDeafen,
  onToggleScreenShare,
  displayName,
  onDisplayNameChange,
}: Props) {
  const joinState = useStore((s) => s.joinState);
  const selfMuted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.deafened);
  const configReady = useStore((s) => s.configReady);
  const sharingScreen = useStore((s) => s.selfScreenStream !== null);

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
  let HeroIcon: LucideIcon;
  if (joined) {
    heroLabel = 'Отключиться';
    HeroIcon = WifiOff;
  } else if (joining) {
    heroLabel = 'Подключение…';
    HeroIcon = Wifi;
  } else {
    heroLabel = 'Подключиться';
    HeroIcon = Wifi;
  }

  const tileOn = 'bg-bg-0 border border-accent text-accent hover:bg-[rgba(75,226,119,0.08)]';
  const tileOff = 'bg-bg-0 border border-danger text-danger hover:bg-[rgba(248,113,113,0.08)]';

  return (
    <section className="card grid gap-5 p-6">
      <div className="grid gap-3">
        <h2 className="card-title">Подключение</h2>

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
              <Mic size={24} className="shrink-0" />
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
              <Volume2 size={24} className="shrink-0" />
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
            <HeroIcon size={32} className="shrink-0" />
            <span className="flex-1 text-center">{heroLabel}</span>
          </button>

          {joined &&
            (isTauri() ? (
              <button
                id="screen-share-button"
                type="button"
                disabled
                title="Показ экрана пока доступен только в браузере. В десктоп-приложении — в работе."
                className="flex items-center p-4 bg-bg-0 border border-line text-muted-2 cursor-not-allowed opacity-60"
              >
                <ScreenShare size={24} className="shrink-0" />
                <span className="flex-1 text-center text-[14px] font-bold uppercase tracking-[0.18em]">
                  Экран — только в браузере
                </span>
              </button>
            ) : (
              <button
                id="screen-share-button"
                type="button"
                onClick={onToggleScreenShare}
                aria-pressed={sharingScreen}
                title={sharingScreen ? 'Завершить трансляцию' : 'Показать экран'}
                className={`flex items-center p-4 transition-colors duration-150 ${
                  sharingScreen ? tileOff : tileOn
                }`}
              >
                <ScreenShare size={24} className="shrink-0" />
                <span className="flex-1 text-center text-[14px] font-bold uppercase tracking-[0.18em]">
                  {sharingScreen ? 'Завершить экран' : 'Показать экран'}
                </span>
              </button>
            ))}
        </form>
      </div>
    </section>
  );
}
