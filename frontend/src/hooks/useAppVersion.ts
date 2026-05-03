import { useEffect, useState } from "react";
import { isTauri } from "../utils/tauri";
import type {
  UpdateAvailablePayload,
  UpdateErrorPayload,
  UpdateInstallingPayload,
  UpdateProgressPayload,
} from "../ipc";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

type FrontendUpdate = { kind: "frontend"; current: string; next: string };
type DesktopUpdate = { kind: "desktop"; version: string };
export type AppUpdate = FrontendUpdate | DesktopUpdate;

export type DesktopUpdateProgress = {
  downloaded: number;
  total: number | null;
};

export type DesktopApplyState =
  | { phase: "idle" }
  | { phase: "downloading"; progress: DesktopUpdateProgress | null }
  | { phase: "installing" }
  | { phase: "error"; message: string };

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export function useAppVersion(): {
  bootVersion: string | null;
  update: AppUpdate | null;
  reload: () => void;
  applyDesktopUpdate: () => void;
  desktopApplyState: DesktopApplyState;
} {
  const [bootVersion, setBootVersion] = useState<string | null>(null);
  const [frontendNext, setFrontendNext] = useState<string | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdate | null>(null);
  const [desktopApplyState, setDesktopApplyState] = useState<DesktopApplyState>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        scheduleNext();
        return;
      }
      const v = await fetchVersion();
      if (cancelled) return;
      if (v) {
        setBootVersion((prev) => {
          if (prev === null) return v;
          if (prev !== v) setFrontendNext(v);
          return prev;
        });
      }
      scheduleNext();
    };

    const scheduleNext = () => {
      if (cancelled) return;
      timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    void tick();

    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const subs = await Promise.all([
        listen<UpdateAvailablePayload>("update-available", (event) => {
          setDesktopUpdate({ kind: "desktop", version: event.payload.version });
          setDesktopApplyState((prev) => (prev.phase === "error" ? prev : { phase: "idle" }));
        }),
        listen<UpdateProgressPayload>("update-progress", (event) => {
          setDesktopApplyState({
            phase: "downloading",
            progress: { downloaded: event.payload.downloaded, total: event.payload.total },
          });
        }),
        listen<UpdateInstallingPayload>("update-installing", () => {
          setDesktopApplyState({ phase: "installing" });
        }),
        listen<UpdateErrorPayload>("update-error", (event) => {
          setDesktopApplyState({ phase: "error", message: event.payload.message });
        }),
      ]);
      if (cancelled) subs.forEach((off) => off());
      else unlisteners.push(...subs);
    });
    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
    };
  }, []);

  const update: AppUpdate | null = desktopUpdate
    ? desktopUpdate
    : frontendNext && bootVersion
      ? { kind: "frontend", current: bootVersion, next: frontendNext }
      : null;

  const reload = () => {
    window.location.reload();
  };

  const applyDesktopUpdate = () => {
    setDesktopApplyState({ phase: "downloading", progress: null });
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("apply_update").catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err ?? "unknown error");
        setDesktopApplyState({ phase: "error", message });
      });
    });
  };

  return { bootVersion, update, reload, applyDesktopUpdate, desktopApplyState };
}
