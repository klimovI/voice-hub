import { AdminKeyButton } from "./AdminKeyButton";
import { AdminLogoutButton } from "./AdminLogoutButton";
import { StatusPill } from "./StatusPill";

export function TopBar() {
  return (
    <header className="flex items-center justify-between gap-4 p-[14px_18px] border border-line rounded-[20px] bg-[linear-gradient(180deg,rgba(255,255,255,0.02),transparent)] bg-bg-1 max-[640px]:flex-wrap">
      <div className="flex items-center gap-3 font-semibold tracking-[-0.01em]">
        <img
          src="/favicon.svg"
          alt="Voice Hub"
          className="w-11 h-11 rounded-[12px] shadow-[0_8px_26px_-8px_rgba(34,197,94,0.6)]"
        />
        <div className="text-[22px] leading-none">Voice Hub</div>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill />
        <AdminKeyButton />
        <AdminLogoutButton />
      </div>
    </header>
  );
}
