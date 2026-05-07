import { useStore } from '../store/useStore';

export function PingToast() {
  const ping = useStore((s) => s.incomingPing);

  if (!ping) return null;

  return (
    <div
      className="fixed top-4 right-4 z-50
        flex items-center gap-2 px-4 py-2.5
        bg-bg-1 border border-accent text-accent
        text-[13px] font-bold uppercase tracking-[0.14em]
        shadow-lg pointer-events-none
        animate-[fadeIn_0.15s_ease-out]"
      role="status"
      aria-live="polite"
    >
      📍 {ping.fromName} пингует
    </div>
  );
}
