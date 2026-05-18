import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useStore } from '../store/useStore';

interface Props {
  /** Called when user dismisses the overlay — owner unsubscribes from SFU. */
  onClose: () => void;
}

/**
 * Fullscreen overlay showing the focused publisher's video. Mounted only
 * when focusedId is non-null; unmounts entirely on close so the <video>
 * element + srcObject cleanly tear down.
 *
 * System audio (when present) plays through a sibling <audio> element at
 * full volume, separate from the voice mixer — system audio is part of the
 * screen capture and should not be ducked by the user's mic/output sliders.
 */
export function ScreenShareFocused({ onClose }: Props) {
  const focusedId = useScreenShareStore((s) => s.focusedId);
  const videoStream = useScreenShareStore((s) => s.focusedStream);
  const audioStream = useScreenShareStore((s) => s.focusedAudioStream);
  const display = useStore((s) =>
    focusedId ? (s.participants.get(focusedId)?.display ?? `user-${focusedId}`) : '',
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Imperative srcObject attach — React can't bind a MediaStream through
  // the JSX attribute path.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = videoStream;
    // Autoplay needs a primed play() on Safari and some Chromium variants;
    // muted=true is what unlocks it. The actual audio goes through the
    // separate <audio> element below, so muting the video is harmless.
    el.muted = true;
    el.play().catch(() => {
      /* swallowed — autoplay denied; the user can click to play */
    });
  }, [videoStream]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = audioStream;
    el.play().catch(() => {
      /* autoplay denied for audio is fine; will resume on user gesture */
    });
  }, [audioStream]);

  // Escape closes the overlay — matches the native browser fullscreen UX.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!focusedId) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 text-zinc-200">
        <span className="text-sm font-medium truncate">Экран · {display}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="rounded p-1 hover:bg-white/10"
        >
          <X size={18} strokeWidth={2.25} />
        </button>
      </header>
      <div className="flex-1 min-h-0 grid place-items-center px-4 pb-4">
        {videoStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full max-w-full max-h-full object-contain bg-black"
          />
        ) : (
          <div className="text-zinc-400 text-sm">Подключаюсь к потоку…</div>
        )}
      </div>
      {/* Hidden audio sink for system-audio mix. Visible only via volume keys. */}
      <audio ref={audioRef} />
    </div>
  );
}
