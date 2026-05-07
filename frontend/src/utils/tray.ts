import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export async function flashAttention(opts: { tray: boolean; window: boolean }): Promise<void> {
  if (!isTauri()) return;
  if (!opts.tray && !opts.window) return;
  try {
    await invoke('flash_attention', opts);
  } catch {
    // best-effort
  }
}
