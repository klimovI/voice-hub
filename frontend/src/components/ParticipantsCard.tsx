import { useShallow } from 'zustand/react/shallow';
import {
  selectChatOnlyParticipants,
  selectVoiceParticipants,
  useStore,
} from '../store/useStore';
import { ParticipantRow } from './ParticipantRow';
import { usePeersPreview, type PeerPreview } from '../hooks/usePeersPreview';
import { useRoomPeers } from '../hooks/useRoomPeers';
import { ROOM_SLUGS, ROOM_LABELS, type RoomSlug } from '../rooms';

interface Props {
  onRemoteGainChange: () => void;
  onPingUser?: (targetId: string) => void;
  onRoomSelect: (slug: RoomSlug) => void;
}

export function ParticipantsCard({ onRemoteGainChange, onPingUser, onRoomSelect }: Props) {
  const participants = useStore(useShallow(selectVoiceParticipants));
  const lurkers = useStore(useShallow(selectChatOnlyParticipants));
  const joinState = useStore((s) => s.joinState);
  const roomSlug = useStore((s) => s.roomSlug);
  const preview = usePeersPreview();
  const roomPeers = useRoomPeers();

  const showPreview = participants.length === 0 && joinState !== 'joined' && preview.length > 0;
  const showEmpty = participants.length === 0 && !showPreview;

  const liveCount = participants.length || preview.length;

  const isJoining = joinState === 'joining';
  const isJoined = joinState === 'joined';

  const tileOn = 'bg-bg-0 border border-accent text-accent hover:bg-[rgba(75,226,119,0.08)]';

  return (
    <section className="card grid gap-5 p-6">
      <div className="grid gap-3">
        <h2 className="card-title">Комната</h2>
        <div className="grid gap-1.5">
          {ROOM_SLUGS.map((slug: RoomSlug) => {
            const active = slug === roomSlug;
            const peers = roomPeers[slug];
            const total = peers.length;
            const voice = peers.filter((p) => !p.chatOnly).length;
            const text = total - voice;
            const nameLine =
              total > 0
                ? peers
                    .slice()
                    .sort((a, b) => a.id.localeCompare(b.id))
                    .map((p) => p.displayName)
                    .join(', ')
                : null;

            const switchable = isJoined && !active;
            const clickable = !isJoining && (!isJoined || switchable);

            let title: string | undefined;
            if (isJoining) title = 'Подождите…';
            else if (switchable) title = 'Перейти в эту комнату';

            return (
              <button
                key={slug}
                type="button"
                onClick={clickable ? () => onRoomSelect(slug) : undefined}
                title={title}
                className={`flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 ${
                  active
                    ? tileOn
                    : switchable
                      ? 'bg-bg-0 border border-line text-muted hover:border-line-strong hover:border-accent/50'
                      : 'bg-bg-0 border border-line text-muted hover:border-line-strong'
                } ${isJoining ? 'opacity-50 cursor-not-allowed' : active && isJoined ? 'cursor-default' : 'cursor-pointer'}`}
              >
                <span className="text-[13px] font-bold uppercase tracking-[0.15em] shrink-0">
                  {ROOM_LABELS[slug]}
                </span>
                <span
                  className={`text-[12px] tabular-nums tracking-[0.1em] px-2 py-0.5 border shrink-0 ${
                    voice > 0 ? 'border-accent' : 'border-line'
                  }`}
                  title={voice > 0 && text > 0 ? `${voice} в голосе, ${text} в чате` : undefined}
                >
                  {voice > 0 ? (
                    <>
                      <span className="text-accent">{voice}</span>
                      {text > 0 && <span className="text-muted-2">/{text}</span>}
                    </>
                  ) : (
                    <span className="text-muted-2">{total}</span>
                  )}
                </span>
                {nameLine && (
                  <span className="flex-1 min-w-0 text-left text-muted-2 text-[11px] tracking-[0.05em] truncate">
                    {nameLine}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="section-label">Участники</span>
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
          {participants.map((p) => (
            <ParticipantRow
              key={p.id}
              participant={p}
              onRemoteGainChange={onRemoteGainChange}
              onPing={onPingUser}
            />
          ))}
        </div>
      </div>

      {lurkers.length > 0 && (
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="section-label">Только чат</span>
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
        </div>
      )}
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
