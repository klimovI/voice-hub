import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

export async function flashAttention(opts: { tray: boolean; window: boolean }): Promise<void> {
  console.warn('[ping] flashAttention', opts, 'isTauri:', isTauri());
  if (!isTauri()) return;
  if (!opts.tray && !opts.window) return;
  try {
    await invoke('flash_attention', opts);
    console.warn('[ping] flashAttention: invoke ok');
  } catch (err) {
    console.warn('[ping] flashAttention: invoke failed', err);
  }
}
