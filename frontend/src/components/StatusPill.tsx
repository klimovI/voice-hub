import { useStore } from "../store/useStore";

export function StatusPill() {
  const statusText = useStore((s) => s.statusText);
  const statusState = useStore((s) => s.statusState);

  const isOk = statusState === "ok";
  const isErr = statusState === "err";

  const wrapColor = isOk ? "text-good" : isErr ? "text-danger" : "text-text";
  const dotColor = isOk
    ? "bg-good shadow-[0_0_0_4px_rgba(34,197,94,0.14)]"
    : isErr
      ? "bg-danger shadow-[0_0_0_4px_rgba(248,113,113,0.12)]"
      : "bg-muted-2";

  return (
    <div
      id="status"
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-full bg-bg-3 border border-line-strong text-[12px] ${wrapColor}`}
      data-state={statusState}
    >
      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
      <span>{statusText}</span>
    </div>
  );
}
