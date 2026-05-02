import { useAppVersion } from "../hooks/useAppVersion";
import { useStore } from "../store/useStore";
import { REJOIN_ON_LOAD_KEY } from "../utils/rejoin";

export function UpdateBanner() {
  const { update, reload, applyDesktopUpdate } = useAppVersion();
  const joinState = useStore((s) => s.joinState);

  if (!update) return null;

  const isDesktop = update.kind === "desktop";
  const message = isDesktop
    ? `Доступна новая версия Voice Hub (${update.version})`
    : "Доступна новая версия интерфейса";
  const actionLabel = isDesktop ? "Перезапустить" : "Обновить";
  const onAction = () => {
    if (joinState === "joined") {
      localStorage.setItem(REJOIN_ON_LOAD_KEY, "1");
    }
    if (isDesktop) applyDesktopUpdate();
    else reload();
  };

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 px-4 py-3 rounded-[14px] border border-accent/40 bg-accent/10 text-[13px]"
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onAction}
        className="px-3 py-1.5 rounded-full bg-accent text-accent-ink font-semibold text-[12px] hover:opacity-90 transition"
      >
        {actionLabel}
      </button>
    </div>
  );
}
