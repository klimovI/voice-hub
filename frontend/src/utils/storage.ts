export function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadBoolean(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === "true";
}

export function loadPercentage(key: string, fallback: number): number {
  return clampPercentage(loadNumber(key, fallback));
}

export function clampPercentage(value: number | string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 90; // DEFAULT_RNNOISE_MIX
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

export function clearLegacyStorage(): void {
  localStorage.removeItem("voice-hub.mic-mode");
  localStorage.removeItem("voice-hub.rnnoise-enabled");
  localStorage.removeItem("voice-hub.gate-enabled");
  localStorage.removeItem("voice-hub.gate-threshold");
  localStorage.removeItem("voice-hub.gate-attack");
  localStorage.removeItem("voice-hub.gate-release");
}
