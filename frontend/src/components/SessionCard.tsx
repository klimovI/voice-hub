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
  const configReady = useStore((s) => s.configReady);

  const joining = joinState === "joining";
  const joined = joinState === "joined";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (joined) return;
    onJoin(displayName);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    onDisplayNameChange(e.target.value);
  }

  return (
    <section className="card">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="card-title">Комната</h2>
        <span className="card-hint">Голос и подключение</span>
      </div>
      <form id="join-form" onSubmit={handleSubmit} className="grid gap-[14px]">
        <label className="block text-[12px] font-medium text-muted">
          Имя
          <input
            id="display-name"
            name="displayName"
            type="text"
            placeholder="например, Илья"
            autoComplete="off"
            value={displayName}
            onChange={handleNameChange}
            className="input-field"
          />
        </label>
        <div className="grid grid-cols-4 gap-2.5">
          <button
            id="join-button"
            type="submit"
            disabled={joining || joined || !configReady}
            className="btn btn-primary justify-center"
          >
            {configReady ? "Войти" : "Загрузка…"}
          </button>
          <button
            id="self-mute-button"
            type="button"
            disabled={!joined}
            aria-pressed={selfMuted ? "true" : "false"}
            onClick={onToggleSelfMute}
            className={`btn justify-center ${selfMuted ? "btn-toggle-on" : "btn-secondary"}`}
          >
            {selfMuted ? "Включить" : "Выключить"}
          </button>
          <button
            id="deafen-button"
            type="button"
            disabled={!joined}
            aria-pressed={deafened ? "true" : "false"}
            onClick={onToggleDeafen}
            className={`btn justify-center ${deafened ? "btn-toggle-on" : "btn-secondary"}`}
          >
            {deafened ? "Слушать" : "Заглушить"}
          </button>
          <button
            id="leave-button"
            type="button"
            disabled={!joined}
            onClick={onLeave}
            className="btn btn-danger justify-center"
          >
            Выйти
          </button>
        </div>
      </form>
    </section>
  );
}
