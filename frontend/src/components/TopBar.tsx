import { AdminKeyButton } from './AdminKeyButton';
import { LogoutButton } from './LogoutButton';
import { StatusPill } from './StatusPill';

export function TopBar() {
  return (
    <header
      className="flex items-center justify-between gap-4 h-14 pl-4 pr-2.5 md:pl-6
        bg-bg-1 border border-line
        max-[640px]:flex-wrap max-[640px]:h-auto max-[640px]:py-3"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="msym msym-fill text-accent md:hidden" style={{ fontSize: 20 }}>
          graphic_eq
        </span>
        <div className="text-[17px] font-extrabold uppercase tracking-[0.2em] text-accent">
          Voice&nbsp;Hub
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill />
        <AdminKeyButton />
        <LogoutButton />
      </div>
    </header>
  );
}
