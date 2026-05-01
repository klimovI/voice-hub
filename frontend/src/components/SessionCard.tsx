import { useStore } from "../store/useStore";

interface Props {
  onJoin: (displayName: string) => void;
  onLeave: () => void;
  onToggleSelfMute: () => void;
  onToggleDeafen: () => void;
  displayName: string;
  onDisplayNameChange: (value: string) => void;
}

export function SessionCard({
  onJoin,
  onLeave,
  onToggleSelfMute,
  onToggleDeafen,
  displayName,
  onDisplayNameChange,
}: Props) {
  const joinState = useStore((s) => s.joinState);
  const selfMuted = useStore((s) => s.selfMuted);
  const deafened = useStore((s) => s.deafened);

  const joining = joinState === "joining";
  const joined = joinState === "joined";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (joined) return;
    onJoin(displayName);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    onDisplayNameChange(value);
    if (value.trim()) {
      localStorage.setItem("voice-hub.display-name", value.trim());
    } else {
      localStorage.removeItem("voice-hub.display-name");
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Session</h2>
        <span className="card-hint">Microphone &amp; room</span>
      </div>
      <form id="join-form" onSubmit={handleSubmit}>
        <label>
          Display name
          <input
            id="display-name"
            name="displayName"
            type="text"
            placeholder="e.g. Ilya"
            autoComplete="off"
            value={displayName}
            onChange={handleNameChange}
          />
        </label>
        <div className="actions">
          <button id="join-button" type="submit" disabled={joining || joined}>
            Join Room
          </button>
          <button
            id="self-mute-button"
            className="secondary"
            type="button"
            disabled={!joined}
            aria-pressed={selfMuted ? "true" : "false"}
            onClick={onToggleSelfMute}
          >
            {selfMuted ? "Unmute Me" : "Mute Me"}
          </button>
          <button
            id="deafen-button"
            className="secondary"
            type="button"
            disabled={!joined}
            aria-pressed={deafened ? "true" : "false"}
            onClick={onToggleDeafen}
          >
            {deafened ? "Undeafen" : "Deafen"}
          </button>
          <button
            id="leave-button"
            className="danger"
            type="button"
            disabled={!joined}
            onClick={onLeave}
          >
            Leave
          </button>
        </div>
      </form>
    </section>
  );
}
