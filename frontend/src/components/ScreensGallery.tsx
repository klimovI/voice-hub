import { useEffect, useRef, useState } from 'react';
import { Maximize, ScreenShare } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { ParticipantUI } from '../types';

interface Props {
  onStopSelfShare: () => void;
  onWatch: (peerId: string) => void;
  onUnwatch: (peerId: string) => void;
}

interface ViewerProps {
  label: string;
  stream: MediaStream | null;
  muted: boolean;
  actions: { label: string; onClick: () => void; danger?: boolean; icon?: string }[];
}

function ScreenViewer({ label, stream, muted, actions }: ViewerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    el.muted = muted;
    el.playsInline = true;
    el.play().catch(() => {
      /* autoplay can be blocked until user gesture */
    });
    return () => {
      el.srcObject = null;
    };
  }, [stream, muted]);

  // Fullscreen the wrapper div, not the <video> — Chromium otherwise
  // overlays native media controls (timer, pause) on the fullscreen video.
  function goFullscreen() {
    const el = wrapRef.current;
    if (!el) return;
    el.requestFullscreen().catch((err: unknown) => {
      console.warn('[screens] requestFullscreen failed:', err);
    });
  }

  return (
    <div className="card grid gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-bold uppercase tracking-[0.18em] text-muted truncate">
          {label}
        </span>
        <div className="flex items-center gap-3">
          {stream && (
            <button
              type="button"
              onClick={goFullscreen}
              title="На весь экран"
              className="text-muted hover:text-accent grid place-items-center"
            >
              <Maximize size={18} />
            </button>
          )}
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              title={a.label}
              className={`text-[11px] font-bold uppercase tracking-[0.18em] hover:underline ${
                a.danger ? 'text-danger' : 'text-muted hover:text-accent'
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrapRef} className="w-full bg-bg-0 border border-line fs-wrap">
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full"
            style={{ aspectRatio: '16 / 9', objectFit: 'contain' }}
          />
        ) : (
          <div
            className="w-full h-full grid place-items-center text-muted-2 text-[12px] uppercase tracking-[0.18em]"
            style={{ aspectRatio: '16 / 9' }}
          >
            Загружаем поток…
          </div>
        )}
      </div>
    </div>
  );
}

interface PlaceholderProps {
  name: string;
  onOpen: () => void;
}

function ScreenPlaceholder({ name, onOpen }: PlaceholderProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="card flex items-center gap-3 p-4 text-left hover:border-accent transition-colors"
    >
      <ScreenShare size={28} className="text-accent shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-[14px] font-bold text-body truncate">{name}</span>
        <span className="block text-[11px] uppercase tracking-[0.18em] text-muted-2">
          делится экраном — нажмите, чтобы открыть
        </span>
      </span>
      <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-accent">
        Открыть
      </span>
    </button>
  );
}

export function ScreensGallery({ onStopSelfShare, onWatch, onUnwatch }: Props) {
  const selfStream = useStore((s) => s.selfScreenStream);
  const participants = useStore((s) => s.participants);

  // Sourced from server-driven screenSharing, not screenStream — the stream
  // only arrives after watch-screen triggers a renegotiation.
  const sharers: ParticipantUI[] = [];
  for (const p of participants.values()) {
    if (!p.isSelf && p.screenSharing) sharers.push(p);
  }

  const [opened, setOpened] = useState<Set<string>>(() => new Set());

  // A fresh share is a new invitation, not an auto-resume; drop opened
  // entries for peers that stopped sharing.
  useEffect(() => {
    setOpened((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const p of participants.values()) {
        if (!p.isSelf && p.screenSharing && prev.has(p.id)) next.add(p.id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [participants]);

  if (!selfStream && sharers.length === 0) return null;

  const selfName = (() => {
    for (const p of participants.values()) if (p.isSelf) return p.display;
    return 'Вы';
  })();

  function open(id: string) {
    onWatch(id);
    setOpened((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  function close(id: string) {
    onUnwatch(id);
    setOpened((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  return (
    <section className="grid gap-3">
      {selfStream && (
        <ScreenViewer
          label={`${selfName} · ваш экран`}
          stream={selfStream}
          muted
          actions={[{ label: 'Завершить', onClick: onStopSelfShare, danger: true }]}
        />
      )}
      {sharers.map((p) =>
        opened.has(p.id) ? (
          <ScreenViewer
            key={p.id}
            label={`${p.display} · экран`}
            stream={p.screenStream ?? null}
            muted={false}
            actions={[{ label: 'Закрыть', onClick: () => close(p.id) }]}
          />
        ) : (
          <ScreenPlaceholder key={p.id} name={p.display} onOpen={() => open(p.id)} />
        ),
      )}
    </section>
  );
}
