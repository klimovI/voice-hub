import { useStore } from '../store/useStore';
import { savePeerVolume } from '../utils/storage';
import type { ParticipantUI } from '../types';

interface Props {
  participant: ParticipantUI;
  onRemoteGainChange: () => void;
}

export function ParticipantRow({ participant, onRemoteGainChange }: Props) {
  const updateParticipant = useStore((s) => s.updateParticipant);

  const isMuted = participant.isSelf ? participant.selfMuted : participant.localMuted;
  const isReady = participant.isSelf || participant.hasStream;

  let metaText: string;
  let metaTone: 'good' | 'danger' | 'muted' | 'connecting';
  if (participant.isSelf) {
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

  // Voice activity ring (DESIGN.md): solid green border on speaker. Border width fixed at 2px
  // across states so toggling speaking doesn't shift layout.
  const rowClass = participant.speaking
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

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center px-4 h-[72px] transition-[border-color,background] duration-150 max-[640px]:grid-cols-1 max-[640px]:h-auto max-[640px]:py-4 ${rowClass}`}
    >
      <div className="grid grid-cols-[40px_1fr] gap-3 items-center min-w-0">
        <div
          className={`grid place-items-center rounded-full bg-accent text-accent-ink font-extrabold text-[20px] uppercase shrink-0 ${avatarRing}`}
          style={{ width: 40, height: 40 }}
        >
          {initial}
        </div>
        <div className="min-w-0">
          <div className="text-[18px] font-bold text-body whitespace-nowrap overflow-hidden text-ellipsis tracking-tight">
            {participant.isSelf ? `${participant.display} (вы)` : participant.display}
          </div>
          <div
            className={`mt-0.5 text-[11px] uppercase tracking-[0.18em] inline-flex items-center gap-1.5 ${metaTextClass}`}
          >
            <span className={`w-1.5 h-1.5 ${metaDotClass}`} />
            {metaText}
          </div>
        </div>
      </div>

      <div className="flex gap-2 items-center justify-end max-[640px]:justify-start max-[640px]:flex-wrap">
        {!participant.isSelf && (
          <>
            {(participant.remoteMuted || participant.remoteDeafened) && (
              <div className="flex gap-1 items-center">
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
            <button
              type="button"
              onClick={handleToggleMute}
              aria-pressed={participant.localMuted}
              aria-label={participant.localMuted ? 'Слушать' : 'Заглушить'}
              title={participant.localMuted ? 'Слушать' : 'Заглушить'}
              className={`grid place-items-center w-9 h-9 border transition-colors ${
                participant.localMuted
                  ? 'border-danger text-danger bg-[rgba(248,113,113,0.08)] hover:bg-danger hover:text-accent-ink'
                  : 'border-line text-muted hover:border-accent hover:text-accent'
              }`}
            >
              <span className="msym" style={{ fontSize: 18 }}>
                {participant.localMuted ? 'volume_off' : 'volume_up'}
              </span>
            </button>
            <label className="grid gap-1 w-44 max-[640px]:w-full">
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
          </>
        )}
      </div>
    </div>
  );
}
