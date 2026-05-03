import type { AppConfig, Role } from "./types";

export async function loadAppConfig(): Promise<AppConfig> {
  const response = await fetch("/api/config", { credentials: "same-origin" });
  if (response.status === 401) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace("/login.html?next=" + next);
    throw new Error("Требуется вход");
  }
  if (!response.ok) {
    throw new Error("Не удалось получить конфиг комнаты");
  }
  const raw = (await response.json()) as { iceServers?: unknown; role?: unknown };
  if (!Array.isArray(raw.iceServers)) {
    throw new Error("Конфиг: iceServers отсутствует или не массив");
  }
  if (raw.role !== "admin" && raw.role !== "user") {
    throw new Error(`Конфиг: неизвестная роль "${String(raw.role)}"`);
  }
  return { iceServers: raw.iceServers as RTCIceServer[], role: raw.role as Role };
}

export function buildWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

// DTLN vendor assets live at this base URL.
export const DTLN_ASSET_BASE = new URL("./vendor/dtln/", window.location.href).href;

// DeepFilterNet3 vendor assets live at this base URL.
export const DFN3_ASSET_BASE = new URL("./vendor/dfn3/", window.location.href).href;
