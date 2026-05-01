import { useStore } from "../store/useStore";

export function StatusPill() {
  const statusText = useStore((s) => s.statusText);
  const statusState = useStore((s) => s.statusState);

  return (
    <div id="status" className="conn" data-state={statusState}>
      <span className="dot" />
      <span>{statusText}</span>
    </div>
  );
}
