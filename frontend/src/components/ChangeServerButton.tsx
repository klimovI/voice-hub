import { useCallback } from "react";
import { isTauri } from "../utils/tauri";

export function ChangeServerButton() {
  const handleClick = useCallback(async () => {
    // Same Rust command as the tray "Change server" item — clears browsing
    // data for the current host and navigates back to connect.html, keeping
    // the saved host so the form pre-fills with the previous value.
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("change_server");
  }, []);

  if (!isTauri()) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      title="Сменить сервер"
      aria-label="Сменить сервер"
      className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-bg-3 border border-line-strong text-muted hover:text-text hover:border-line transition-colors"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m16 3 4 4-4 4" />
        <path d="M20 7H4" />
        <path d="m8 21-4-4 4-4" />
        <path d="M4 17h16" />
      </svg>
    </button>
  );
}
