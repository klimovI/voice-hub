import { useStore } from "../store/useStore";
import { ParticipantRow } from "./ParticipantRow";

interface Props {
  onRemoteGainChange: () => void;
}

export function ParticipantsCard({ onRemoteGainChange }: Props) {
  const participants = useStore((s) => s.participants);

  const sorted = Array.from(participants.values()).sort((a, b) => {
    if (a.isSelf) return -1;
    if (b.isSelf) return 1;
    return a.display.localeCompare(b.display);
  });

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="card-title">Participants</h2>
        <span className="card-hint">Per-user volume &amp; mute</span>
      </div>
      <div id="participants" className="grid gap-2.5">
        {sorted.length === 0 ? (
          <div className="p-7 text-center text-muted border border-dashed border-line-strong rounded-[14px] bg-bg-2 text-[13px]">
            No one here yet — share the room link to invite people.
          </div>
        ) : (
          sorted.map((p) => (
            <ParticipantRow key={p.id} participant={p} onRemoteGainChange={onRemoteGainChange} />
          ))
        )}
      </div>
    </section>
  );
}
