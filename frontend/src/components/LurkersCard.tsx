import { useStore } from '../store/useStore';
import { ParticipantRow } from './ParticipantRow';

export function LurkersCard() {
  const participants = useStore((s) => s.participants);

  const lurkers = Array.from(participants.values())
    .filter((p) => p.chatOnly)
    .sort((a, b) => {
      if (a.isSelf) return -1;
      if (b.isSelf) return 1;
      return (a.clientId ?? a.id).localeCompare(b.clientId ?? b.id);
    });

  if (lurkers.length === 0) return null;

  const voiceCount = Array.from(participants.values()).filter((p) => !p.chatOnly).length;
  const title =
    voiceCount > 1 && lurkers.length === 1
      ? 'Зашторный куколд'
      : 'Только чат';

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between gap-3 mb-5">
        <h2 className="card-title">{title}</h2>
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-2 tabular-nums shrink-0">
          {lurkers.length}
        </span>
      </div>
      <div className="grid gap-2">
        {lurkers.map((p) => (
          <ParticipantRow key={p.id} participant={p} onRemoteGainChange={() => undefined} />
        ))}
      </div>
    </section>
  );
}
