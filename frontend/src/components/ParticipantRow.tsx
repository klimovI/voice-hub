import { useStore } from "../store/useStore";
import { savePeerVolume } from "../utils/storage";
import type { ParticipantUI } from "../types";

interface Props {
  participant: ParticipantUI;
  onRemoteGainChange: () => void;
}

export function ParticipantRow({ participant, onRemoteGainChange }: Props) {
  const updateParticipant = useStore((s) => s.updateParticipant);

  const isMuted = participant.isSelf ? participant.selfMuted : participant.localMuted;
  const isReady = participant.isSelf || participant.hasStream;

  let metaText: string;
  let metaTone: "good" | "danger" | "muted" | "connecting";
  if (participant.isSelf) {
    if (participant.selfMuted) {
      metaText = "микрофон выключен";
      metaTone = "danger";
    } else if (participant.speaking) {
      metaText = "говорит";
      metaTone = "good";
    } else {
      metaText = "в эфире";
      metaTone = "muted";
    }
  } else if (participant.hasStream) {
    if (participant.localMuted) {
      metaText = "заглушён вами";
      metaTone = "danger";
    } else if (participant.speaking) {
      metaText = "говорит";
      metaTone = "good";
    } else {
      metaText = "слышно";
      metaTone = "muted";
    }
  } else {
    metaText = "подключается";
    metaTone = "connecting";
  }

  const initial = (participant.display || "?").trim().charAt(0).toUpperCase() || "?";

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

  const rowClass = participant.speaking
    ? "border-accent shadow-[0_0_0_1px_var(--color-accent),0_8px_30px_-10px_rgba(34,197,94,0.45)] " +
      "bg-[linear-gradient(180deg,rgba(34,197,94,0.14),transparent)] bg-bg-2"
    : isMuted
      ? "border-line bg-bg-2 hover:border-line-strong hover:bg-bg-3"
      : !isReady
        ? "border-line bg-bg-2"
        : "border-line bg-bg-2 hover:border-line-strong hover:bg-bg-3";

  const metaDotClass =
    metaTone === "good"
      ? "bg-good shadow-[0_0_0_3px_rgba(34,197,94,0.14)]"
      : metaTone === "danger"
        ? "bg-danger"
        : metaTone === "connecting"
          ? "bg-accent animate-[vh-pulse_1.4s_ease-in-out_infinite]"
          : "bg-muted-2";

  const metaTextClass =
    metaTone === "good" ? "text-good" : metaTone === "danger" ? "text-danger" : "text-muted";

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] gap-4 items-center px-4 py-3.5 border rounded-[14px] transition-[border-color,background,box-shadow] duration-150 max-[640px]:grid-cols-1 ${rowClass}`}
    >
      <div className="grid grid-cols-[36px_1fr] gap-3 items-center min-w-0">
        <div className="grid place-items-center w-9 h-9 rounded-full bg-accent text-accent-ink font-extrabold text-[14px] uppercase shrink-0 shadow-[0_4px_14px_-4px_rgba(34,197,94,0.5)]">
          {initial}
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-text whitespace-nowrap overflow-hidden text-ellipsis">
            {participant.isSelf ? `${participant.display} (вы)` : participant.display}
          </div>
          <div className={`mt-0.5 text-[12px] inline-flex items-center gap-1.5 ${metaTextClass}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${metaDotClass}`} />
            {metaText}
          </div>
        </div>
      </div>

      <div className="flex gap-3.5 items-center justify-end max-[640px]:justify-start max-[640px]:flex-wrap">
        {!participant.isSelf && (
          <>
            <button
              type="button"
              onClick={handleToggleMute}
              className={`btn btn-mini ${participant.localMuted ? "btn-toggle-on" : "btn-secondary"}`}
            >
              {participant.localMuted ? "Слушать" : "Заглушить"}
            </button>
            <label className="grid gap-1 w-50 max-[640px]:w-full">
              <span className="whitespace-nowrap tabular-nums text-[11px] text-muted">
                Громкость {participant.localVolume}%
              </span>
              <input
                type="range"
                min="0"
                max="300"
                step="5"
                value={participant.localVolume}
                onChange={handleVolumeChange}
                className="vh-range"
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
