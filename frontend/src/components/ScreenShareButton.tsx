import { ScreenShare, ScreenShareOff } from 'lucide-react';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useStore } from '../store/useStore';

interface Props {
  onStart: () => void | Promise<void>;
  onStop: () => void;
}

// Android Chrome and a few mobile browsers ship MediaDevices without
// getDisplayMedia. Calling it throws "not a function"; hide the entry point
// entirely so the user doesn't see a control that can't deliver.
const screenCaptureSupported =
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/**
 * Single in-bar button that toggles screen-share publishing. Greyed out
 * outside the joined state. Label flips on `myStatus`; the transient
 * "starting" / "stopping" states disable the button to prevent double-fire
 * during getDisplayMedia / WS round-trip.
 */
export function ScreenShareButton({ onStart, onStop }: Props) {
  const joinState = useStore((s) => s.joinState);
  const myStatus = useScreenShareStore((s) => s.myStatus);

  if (!screenCaptureSupported) return null;

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
      className={`btn w-full ${publishing ? 'btn-danger' : 'btn-secondary'}`}
    >
      <Icon size={16} strokeWidth={2.25} />
      <span>{label}</span>
    </button>
  );
}
