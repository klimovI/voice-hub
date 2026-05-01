import { StatusPill } from "./StatusPill";

export function TopBar() {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">V</div>
        <div>
          <div className="brand-title">Voice Hub</div>
          <div className="brand-sub">Low-latency voice over WebRTC</div>
        </div>
      </div>
      <StatusPill />
    </header>
  );
}
