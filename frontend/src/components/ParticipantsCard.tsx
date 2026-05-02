import { useStore } from "../store/useStore";
import { ParticipantRow } from "./ParticipantRow";
import { usePeersPreview, type PeerPreview } from "../hooks/usePeersPreview";

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

  const showPreview = sorted.length === 0 && joinState !== "joined" && preview.length > 0;
  const showEmpty = sorted.length === 0 && !showPreview;

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="card-title">Participants</h2>
        <span className="card-hint">
          {showPreview ? "In room — connect to talk" : "Per-user volume & mute"}
        </span>
      </div>
      <div id="participants" className="grid gap-2.5">
        {showEmpty && (
          <div className="p-7 text-center text-muted border border-dashed border-line-strong rounded-[14px] bg-bg-2 text-[13px]">
            No one here yet — share the room link to invite people.
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
  const initial = (peer.displayName || "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-center px-4 py-3.5 border border-line rounded-[14px] bg-bg-2 opacity-80">
      <div className="grid grid-cols-[36px_1fr] gap-3 items-center min-w-0">
        <div className="grid place-items-center w-9 h-9 rounded-full bg-bg-3 text-muted font-extrabold text-[14px] uppercase shrink-0">
          {initial}
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-text whitespace-nowrap overflow-hidden text-ellipsis">
            {peer.displayName}
          </div>
          <div className="mt-0.5 text-[12px] inline-flex items-center gap-1.5 text-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-2" />
            in room
          </div>
        </div>
      </div>
    </div>
  );
}
