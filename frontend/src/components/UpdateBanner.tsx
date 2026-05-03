import type { AppUpdate, DesktopApplyState, DesktopUpdateProgress } from "../hooks/useAppVersion";
import { useStore } from "../store/useStore";
import { setRejoinFlag } from "../utils/storage";

interface Props {
  update: AppUpdate | null;
  reload: () => void;
  applyDesktopUpdate: () => void;
  desktopApplyState: DesktopApplyState;
}

function formatProgress(progress: DesktopUpdateProgress | null): string {
  if (!progress) return "Загрузка обновления…";
  if (progress.total && progress.total > 0) {
    const pct = Math.min(100, Math.floor((progress.downloaded / progress.total) * 100));
    return `Загрузка обновления… ${pct}%`;
  }
  const mb = progress.downloaded / (1024 * 1024);
  return `Загрузка обновления… ${mb.toFixed(1)} МБ`;
}

function progressFraction(progress: DesktopUpdateProgress | null): number | null {
  if (!progress || !progress.total || progress.total <= 0) return null;
  return Math.min(1, progress.downloaded / progress.total);
}

export function UpdateBanner({ update, reload, applyDesktopUpdate, desktopApplyState }: Props) {
  const joinState = useStore((s) => s.joinState);

  if (!update) return null;

  const isDesktop = update.kind === "desktop";

  let message: string;
  let actionLabel: string | null;
  let actionDisabled = false;
  let bar: number | null = null;

  if (!isDesktop) {
    message = "Доступна новая версия интерфейса";
    actionLabel = "Обновить";
  } else {
    switch (desktopApplyState.phase) {
      case "downloading":
        message = formatProgress(desktopApplyState.progress);
        actionLabel = null;
        actionDisabled = true;
        bar = progressFraction(desktopApplyState.progress);
        break;
      case "installing":
        message = "Устанавливаем обновление…";
        actionLabel = null;
        actionDisabled = true;
        bar = 1;
        break;
      case "error":
        message = `Не удалось установить обновление: ${desktopApplyState.message}`;
        actionLabel = "Попробовать снова";
        break;
      case "idle":
      default:
        message = `Доступна новая версия Voice Hub (${update.version})`;
        actionLabel = "Перезапустить";
        break;
    }
  }

  const onAction = () => {
    if (actionDisabled) return;
    if (joinState === "joined") {
      setRejoinFlag();
    }
    if (isDesktop) applyDesktopUpdate();
    else reload();
  };

  return (
    <div
      role="status"
      className="flex flex-col gap-2 px-4 py-3 rounded-[14px] border border-accent/40 bg-accent/10 text-[13px]"
    >
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        {actionLabel && (
          <button
            type="button"
            onClick={onAction}
            disabled={actionDisabled}
            className="px-3 py-1.5 rounded-full bg-accent text-accent-ink font-semibold text-[12px] hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {actionLabel}
          </button>
        )}
      </div>
      {bar !== null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-accent/20">
          <div
            className="h-full bg-accent transition-[width] duration-150 ease-out"
            style={{ width: `${Math.round(bar * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
