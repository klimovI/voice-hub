import { useEffect, useState } from "react";
import { isTauri } from "../utils/tauri";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

type FrontendUpdate = { kind: "frontend"; current: string; next: string };
type DesktopUpdate = { kind: "desktop"; version: string };
export type AppUpdate = FrontendUpdate | DesktopUpdate;

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
} {
  const [bootVersion, setBootVersion] = useState<string | null>(null);
  const [frontendNext, setFrontendNext] = useState<string | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdate | null>(null);

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
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ version: string }>("update-available", (event) => {
        setDesktopUpdate({ kind: "desktop", version: event.payload.version });
      }).then((off) => {
        if (cancelled) off();
        else unlisten = off;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
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
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("apply_update").catch(() => {
        /* user can retry from tray */
      });
    });
  };

  return { bootVersion, update, reload, applyDesktopUpdate };
}
