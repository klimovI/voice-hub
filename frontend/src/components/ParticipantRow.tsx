import { useStore } from "../store/useStore";
import type { ParticipantUI } from "../types";

interface Props {
  participant: ParticipantUI;
  onRemoteGainChange: () => void;
}

export function ParticipantRow({ participant, onRemoteGainChange }: Props) {
  const updateParticipant = useStore((s) => s.updateParticipant);

  const isMuted = participant.isSelf ? participant.selfMuted : participant.localMuted;
  const isReady = participant.isSelf || participant.hasStream;

  let rowState: string;
  if (participant.speaking) {
    rowState = "speaking";
  } else if (isMuted) {
    rowState = "muted";
  } else if (!isReady) {
    rowState = "connecting";
  } else {
    rowState = "live";
  }

  let metaText: string;
  if (participant.isSelf) {
    metaText = participant.selfMuted ? "muted locally" : participant.speaking ? "speaking" : "live";
  } else if (participant.hasStream) {
    metaText = participant.localMuted
      ? "muted locally"
      : participant.speaking
        ? "speaking"
        : "receiving";
  } else {
    metaText = "connecting";
  }

  const initial = (participant.display || "?").trim().charAt(0) || "?";

  function handleToggleMute() {
    updateParticipant(participant.id, { localMuted: !participant.localMuted });
    onRemoteGainChange();
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const volume = Number(e.target.value);
    updateParticipant(participant.id, { localVolume: volume });
    onRemoteGainChange();
  }

  return (
    <div
      className={`participant-row${participant.speaking ? " participant-speaking" : ""}`}
      data-state={rowState}
    >
      <div className="participant-info" data-initial={initial}>
        <div style={{ minWidth: 0 }}>
          <div className="participant-name">
            {participant.isSelf ? `${participant.display} (you)` : participant.display}
          </div>
          <div className="participant-meta">{metaText}</div>
        </div>
      </div>

      <div className="participant-actions">
        {!participant.isSelf && (
          <>
            <button
              type="button"
              className="mini-button secondary"
              onClick={handleToggleMute}
            >
              {participant.localMuted ? "Unmute User" : "Mute User"}
            </button>
            <label className="participant-slider">
              <span>Volume {participant.localVolume}%</span>
              <input
                type="range"
                min="0"
                max="500"
                step="5"
                value={participant.localVolume}
                onChange={handleVolumeChange}
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
