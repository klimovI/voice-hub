import { useStore } from '../store/useStore';
import { savePeerVolume } from '../utils/storage';
import type { ParticipantUI } from '../types';

interface Props {
  participant: ParticipantUI;
  onRemoteGainChange: () => void;
  onPing?: (targetId: string) => void;
}

export function ParticipantRow({ participant, onRemoteGainChange, onPing }: Props) {
  const updateParticipant = useStore((s) => s.updateParticipant);
  const lastPingSentAt = useStore((s) => s.lastPingSentByTarget.get(participant.id) ?? 0);
  const pingCoolingDown = Date.now() - lastPingSentAt < 10000;

  const isLurker = Boolean(participant.chatOnly);
  const isMuted = participant.isSelf ? participant.selfMuted : participant.localMuted;
  const isReady = participant.isSelf || participant.hasStream;

  let metaText: string;
  let metaTone: 'good' | 'danger' | 'muted' | 'connecting';
  if (isLurker) {
    metaText = 'только чат';
    metaTone = 'muted';
  } else if (participant.isSelf) {
    if (participant.selfMuted) {
      metaText = 'микрофон выключен';
      metaTone = 'danger';
    } else if (participant.speaking) {
      metaText = 'говорит';
      metaTone = 'good';
    } else {
      metaText = 'в эфире';
      metaTone = 'muted';
    }
  } else if (participant.hasStream) {
    if (participant.localMuted) {
      metaText = 'заглушён вами';
      metaTone = 'danger';
    } else if (participant.remoteDeafened) {
      metaText = 'не слышит';
      metaTone = 'danger';
    } else if (participant.remoteMuted) {
      metaText = 'микрофон выключен';
      metaTone = 'danger';
    } else if (participant.speaking) {
      metaText = 'говорит';
      metaTone = 'good';
    } else {
      metaText = 'слышно';
      metaTone = 'muted';
    }
  } else {
    metaText = 'подключается';
    metaTone = 'connecting';
  }

  const initial = (participant.display || '?').trim().charAt(0).toUpperCase() || '?';

  function handleToggleMute() {
    updateParticipant(participant.id, { localMuted: !participant.localMuted });
    onRemoteGainChange();
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const volume = Number(e.target.value);
    updateParticipant(participant.id, { localVolume: volume });
    if (participant.clientId) {
      savePeerVolume(participant.clientId, volume);
    }
    onRemoteGainChange();
  }

  // Voice activity ring: solid green border on speaker. Border width fixed at 2px so toggling speaking doesn't shift layout.
  const rowClass = isLurker
    ? 'border-2 border-line bg-bg-0 opacity-50'
    : participant.speaking
      ? 'border-2 border-accent bg-bg-0'
      : isMuted
        ? 'border-2 border-line bg-bg-0'
        : !isReady
          ? 'border-2 border-line bg-bg-0 opacity-70'
          : 'border-2 border-line bg-bg-0 hover:border-line-strong';

  const metaDotClass =
    metaTone === 'good'
      ? 'bg-good'
      : metaTone === 'danger'
        ? 'bg-danger'
        : metaTone === 'connecting'
          ? 'bg-accent animate-[vh-pulse_1.4s_ease-in-out_infinite]'
          : 'bg-muted-2';

  const metaTextClass =
    metaTone === 'good' ? 'text-good' : metaTone === 'danger' ? 'text-danger' : 'text-muted-2';

  const avatarRing = participant.speaking ? 'ring-2 ring-accent ring-offset-0' : '';

  const showIndicators =
    !participant.isSelf && !isLurker && (participant.remoteMuted || participant.remoteDeafened);

  return (
    <div
      className={`grid gap-3 px-4 ${participant.isSelf ? 'h-[72px] items-center' : 'py-3'} transition-[border-color,background] duration-75 ${rowClass}`}
    >
      <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] gap-3 items-center">
        {isLurker && !participant.isSelf && onPing != null ? (
          <button
            type="button"
            disabled={pingCoolingDown}
            onClick={() => onPing(participant.id)}
            aria-label={`Пингануть ${participant.display}`}
            title={pingCoolingDown ? 'Подождите 10 с' : `Пингануть ${participant.display}`}
            className={`group relative grid place-items-center bg-bg-3 text-muted font-extrabold text-[20px] uppercase shrink-0 border-2 border-transparent transition-[border-color] duration-150 ${pingCoolingDown ? 'opacity-40 cursor-not-allowed' : 'hover:border-accent cursor-pointer'}`}
            style={{ width: 40, height: 40 }}
          >
            <span className={`absolute inset-0 flex items-center justify-center transition-opacity duration-150 ${pingCoolingDown ? '' : 'group-hover:opacity-0'}`}>
              {initial}
            </span>
            {!pingCoolingDown && (
              <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 text-accent">
                <span className="msym" style={{ fontSize: 20 }}>
                  notifications
                </span>
              </span>
            )}
          </button>
        ) : (
          <div
            className={`grid place-items-center ${isLurker ? 'bg-bg-3 text-muted' : 'bg-accent text-accent-ink'} font-extrabold text-[20px] uppercase shrink-0 ${avatarRing}`}
            style={{ width: 40, height: 40 }}
          >
            {initial}
          </div>
        )}
        <div className="min-w-0 flex flex-col justify-between" style={{ height: 40 }}>
          <div className="text-[18px] font-bold text-body whitespace-nowrap overflow-hidden text-ellipsis tracking-tight leading-tight">
            {participant.display}
            {participant.isSelf && <span className="text-muted-2 font-normal ml-1.5">[вы]</span>}
          </div>
          <div
            className={`text-[11px] uppercase tracking-[0.18em] inline-flex items-center gap-1.5 leading-none ${metaTextClass}`}
          >
            <span className={`w-1.5 h-1.5 ${metaDotClass}`} />
            {metaText}
          </div>
        </div>
        {showIndicators && (
          <div className="flex gap-1 items-center shrink-0">
            {participant.remoteMuted && (
              <span
                aria-label="Микрофон выключен"
                title="Микрофон выключен"
                className="grid place-items-center w-9 h-9 text-danger border border-danger/40"
              >
                <span className="msym" style={{ fontSize: 18 }}>
                  mic_off
                </span>
              </span>
            )}
            {participant.remoteDeafened && (
              <span
                aria-label="В наушниках"
                title="В наушниках"
                className="grid place-items-center w-9 h-9 text-danger border border-danger/40"
              >
                <span className="msym" style={{ fontSize: 18 }}>
                  hearing_disabled
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {!participant.isSelf && !isLurker && (
        <div className="flex gap-2 items-center">
          <button
            type="button"
            onClick={handleToggleMute}
            aria-pressed={participant.localMuted}
            aria-label={participant.localMuted ? 'Слушать' : 'Заглушить'}
            title={participant.localMuted ? 'Слушать' : 'Заглушить'}
            className={`grid place-items-center w-9 h-9 border transition-colors shrink-0 ${
              participant.localMuted
                ? 'border-danger text-danger bg-[rgba(248,113,113,0.08)] hover:bg-danger hover:text-accent-ink'
                : 'border-line text-muted hover:border-accent hover:text-accent'
            }`}
          >
            <span className="msym" style={{ fontSize: 18 }}>
              {participant.localMuted ? 'volume_off' : 'volume_up'}
            </span>
          </button>
          <label className="grid gap-1 flex-1 min-w-0">
            <span className="whitespace-nowrap tabular-nums text-[11px] font-bold uppercase tracking-[0.18em] text-muted-2">
              Громкость {participant.localVolume}%
            </span>
            <input
              type="range"
              min="0"
              max="300"
              step="5"
              value={participant.localVolume}
              onChange={handleVolumeChange}
              className="vh-range vh-range-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
}
