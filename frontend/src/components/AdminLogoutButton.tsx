import { useCallback } from "react";
import { useIsAdmin } from "../hooks/useIsAdmin";

export function AdminLogoutButton() {
  const isAdmin = useIsAdmin();

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
    } catch {
      // Ignore network errors — cookie may already be invalid; fall through to redirect.
    }
    window.location.replace("/login.html");
  }, []);

  if (!isAdmin) return null;

  return (
    <button
      type="button"
      onClick={handleLogout}
      title="Выйти"
      aria-label="Выйти"
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
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  );
}
