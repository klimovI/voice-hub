import { useShallow } from 'zustand/react/shallow';
import { selectChatOnlyParticipants, useStore } from '../store/useStore';
import { ParticipantRow } from './ParticipantRow';

interface Props {
  onPingUser?: (targetId: string) => void;
}

export function LurkersCard({ onPingUser }: Props) {
  const lurkers = useStore(useShallow(selectChatOnlyParticipants));

  if (lurkers.length === 0) return null;

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between gap-3 mb-5">
        <h2 className="card-title">Только чат</h2>
        <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-2 tabular-nums shrink-0">
          {lurkers.length}
        </span>
      </div>
      <div className="grid gap-2">
        {lurkers.map((p) => (
          <ParticipantRow
            key={p.id}
            participant={p}
            onRemoteGainChange={() => undefined}
            onPing={onPingUser}
          />
        ))}
      </div>
    </section>
  );
}
