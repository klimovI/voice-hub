import { ScreenShare, ScreenShareOff } from 'lucide-react';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useStore } from '../store/useStore';

interface Props {
  onStart: () => void | Promise<void>;
  onStop: () => void;
}

/**
 * Single in-bar button that toggles screen-share publishing. Greyed out
 * outside the joined state. Label flips on `myStatus`; the transient
 * "starting" / "stopping" states disable the button to prevent double-fire
 * during getDisplayMedia / WS round-trip.
 */
export function ScreenShareButton({ onStart, onStop }: Props) {
  const joinState = useStore((s) => s.joinState);
  const myStatus = useScreenShareStore((s) => s.myStatus);

  const joined = joinState === 'joined';
  const busy = myStatus === 'starting' || myStatus === 'stopping';
  const publishing = myStatus === 'publishing';

  function handleClick() {
    if (!joined || busy) return;
    if (publishing) onStop();
    else void onStart();
  }

  let label: string;
  if (myStatus === 'starting') label = 'Запуск…';
  else if (myStatus === 'stopping') label = 'Останавливаю…';
  else if (publishing) label = 'Остановить демонстрацию';
  else label = 'Поделиться экраном';

  const Icon = publishing ? ScreenShareOff : ScreenShare;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!joined || busy}
      className={`flex items-center gap-2 w-full justify-center
        rounded-md px-3 py-2 text-sm font-medium transition
        ${
          publishing
            ? 'bg-red-600/90 hover:bg-red-600 text-white'
            : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-100'
        }
        disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <Icon size={16} strokeWidth={2.25} />
      <span>{label}</span>
    </button>
  );
}
