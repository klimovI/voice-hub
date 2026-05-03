// IPC payloads emitted by the Tauri shell and consumed by the webview.
// Mirrored on the Rust side in src-tauri/src/updater.rs — keep field names
// and optionality in sync. Renaming a field on either side is a wire-format
// break that must land in one logical change.

export type UpdateAvailablePayload = {
  version: string;
};

export type UpdateProgressPayload = {
  downloaded: number;
  total: number | null;
};

export type UpdateInstallingPayload = Record<string, never>;

export type UpdateErrorPayload = {
  message: string;
};

// Return value of the `get_state` Tauri command. Mirrored on the Rust side
// in src-tauri/src/connection.rs (ConnectionState).
export type ConnectionState = {
  has_host: boolean;
  host: string | null;
};
