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

  const sorted = Array.from(participants.values()).sort((a, b) => {
    if (a.isSelf) return -1;
    if (b.isSelf) return 1;
    return a.display.localeCompare(b.display);
  });

  const showPreview = sorted.length === 0 && joinState !== 'joined' && preview.length > 0;
  const showEmpty = sorted.length === 0 && !showPreview;

  const liveCount = sorted.length || preview.length;

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <h2 className="card-title">Участники</h2>
          {liveCount > 0 && (
            <span className="w-1.5 h-1.5 bg-accent animate-[vh-pulse_1.4s_ease-in-out_infinite]" />
          )}
        </div>
        {showPreview ? (
          <span className="card-hint">В комнате — войдите, чтобы говорить</span>
        ) : (
          liveCount > 0 && (
            <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-2 tabular-nums">
              {liveCount}
            </span>
          )
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
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-center px-4 h-[72px] border border-line bg-bg-0 opacity-70">
      <div className="grid grid-cols-[40px_1fr] gap-3 items-center min-w-0">
        <div
          className="grid place-items-center rounded-full bg-bg-3 text-muted font-extrabold text-[20px] uppercase shrink-0"
          style={{ width: 40, height: 40 }}
        >
          {initial}
        </div>
        <div className="min-w-0">
          <div className="text-[18px] font-bold text-body whitespace-nowrap overflow-hidden text-ellipsis tracking-tight">
            {peer.displayName}
          </div>
          <div className="mt-0.5 text-[11px] uppercase tracking-[0.18em] inline-flex items-center gap-1.5 text-muted-2">
            <span className="w-1.5 h-1.5 bg-muted-2" />в комнате
          </div>
        </div>
      </div>
    </div>
  );
}
