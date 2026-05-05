import { useStore } from '../store/useStore';
import { ParticipantRow } from './ParticipantRow';
import { usePeersPreview, type PeerPreview } from '../hooks/usePeersPreview';

interface Props {
  onRemoteGainChange: () => void;
}

export function ParticipantsCard({ onRemoteGainChange }: Props) {
  const participants = useStore((s) => s.participants);
  const joinState = useStore((s) => s.joinState);
  const preview = usePeersPreview();

  // Voice peers only — lurkers go into a separate card.
  const sorted = Array.from(participants.values())
    .filter((p) => !p.chatOnly)
    .sort((a, b) => {
      if (a.isSelf) return -1;
      if (b.isSelf) return 1;
      // Stable by clientId (per-install) so renames don't reorder. Fallback to
      // peer id for peers without a clientId.
      return (a.clientId ?? a.id).localeCompare(b.clientId ?? b.id);
    });

  const showPreview = sorted.length === 0 && joinState !== 'joined' && preview.length > 0;
  const showEmpty = sorted.length === 0 && !showPreview;

  const liveCount = sorted.length || preview.length;

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="card-title">Участники</h2>
          {liveCount > 0 && (
            <span className="w-1.5 h-1.5 bg-accent animate-[vh-pulse_1.4s_ease-in-out_infinite] shrink-0" />
          )}
        </div>
        {!showPreview && liveCount > 0 && (
          <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-2 tabular-nums shrink-0">
            {liveCount}
          </span>
        )}
      </div>
      <div id="participants" className="grid gap-2">
        {showEmpty && (
          <div className="px-4 py-6 text-center text-muted-2 border border-dashed border-line bg-bg-0 text-[12px] uppercase tracking-[0.12em]">
            Пока никого нет
          </div>
        )}
        {showPreview && preview.map((p) => <PeerPreviewRow key={p.id} peer={p} />)}
        {sorted.map((p) => (
          <ParticipantRow key={p.id} participant={p} onRemoteGainChange={onRemoteGainChange} />
        ))}
      </div>
    </section>
  );
}

function PeerPreviewRow({ peer }: { peer: PeerPreview }) {
  const initial = (peer.displayName || '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center px-4 h-[72px] border-2 border-line bg-bg-0 opacity-70">
      <div className="grid grid-cols-[40px_1fr] gap-3 items-center min-w-0">
        <div
          className="grid place-items-center bg-bg-3 text-muted font-extrabold text-[20px] uppercase shrink-0"
          style={{ width: 40, height: 40 }}
        >
          {initial}
        </div>
        <div className="min-w-0 flex flex-col justify-between" style={{ height: 40 }}>
          <div className="text-[18px] font-bold text-body whitespace-nowrap overflow-hidden text-ellipsis tracking-tight leading-tight">
            {peer.displayName}
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] inline-flex items-center gap-1.5 leading-none text-muted-2">
            <span className="w-1.5 h-1.5 bg-muted-2" />в комнате
          </div>
        </div>
      </div>
    </div>
  );
}
