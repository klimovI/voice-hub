import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, X } from 'lucide-react';
import { useScreenShareStore } from '../store/useScreenShareStore';
import { useStore } from '../store/useStore';

interface Props {
  /** Called when user dismisses the overlay — owner unsubscribes from SFU. */
  onClose: () => void;
}

// System audio routes through a sibling <audio> element, not the voice mixer,
// so the publisher's screen-capture audio isn't ducked by mic/output sliders.
export function ScreenShareFocused({ onClose }: Props) {
  const focusedId = useScreenShareStore((s) => s.focusedId);
  const videoStream = useScreenShareStore((s) => s.focusedStream);
  const audioStream = useScreenShareStore((s) => s.focusedAudioStream);
  const hasSystemAudio = useScreenShareStore((s) =>
    focusedId ? (s.shares.get(focusedId)?.hasSystemAudio ?? false) : false,
  );
  const display = useStore((s) =>
    focusedId ? (s.participants.get(focusedId)?.display ?? `user-${focusedId}`) : '',
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioMuted, setAudioMuted] = useState(false);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = videoStream;
    // muted required for autoplay unlock; system audio is routed through the sibling <audio>.
    el.muted = true;
    el.play().catch(() => {});

    setVideoSize(null);
    const update = () => {
      if (!el.videoWidth || !el.videoHeight) return;
      setVideoSize({ w: el.videoWidth, h: el.videoHeight });
    };
    update();
    el.addEventListener('loadedmetadata', update);
    el.addEventListener('resize', update);
    return () => {
      el.removeEventListener('loadedmetadata', update);
      el.removeEventListener('resize', update);
    };
  }, [videoStream]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = audioStream;
    el.play().catch(() => {});
  }, [audioStream]);

  function toggleAudioMute() {
    const next = !audioMuted;
    setAudioMuted(next);
    if (audioRef.current) audioRef.current.muted = next;
  }

  // Escape closes the overlay — matches the native browser fullscreen UX.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!focusedId) return null;

  const qualityLabel = videoSize ? formatQualityLabel(videoSize.h) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 text-zinc-200">
        <span className="text-sm font-medium truncate flex items-center gap-2">
          Экран · {display}
          {qualityLabel && (
            <span className="text-xs font-normal text-zinc-400 px-1.5 py-0.5 rounded bg-zinc-800/80">
              {qualityLabel}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {hasSystemAudio && (
            <button
              type="button"
              onClick={toggleAudioMute}
              aria-label={audioMuted ? 'Включить звук' : 'Выключить звук'}
              className="rounded p-1 hover:bg-white/10"
            >
              {audioMuted ? (
                <VolumeX size={18} strokeWidth={2.25} />
              ) : (
                <Volume2 size={18} strokeWidth={2.25} />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded p-1 hover:bg-white/10"
          >
            <X size={18} strokeWidth={2.25} />
          </button>
        </div>
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
      <audio ref={audioRef} />
    </div>
  );
}

function formatQualityLabel(h: number): string {
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 680) return '720p';
  if (h >= 400) return '480p';
  return `${h}p`;
}
