import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export async function flashTrayAlert(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('flash_tray_alert');
  } catch {
    // Tray flash is best-effort — never bubble.
  }
}
