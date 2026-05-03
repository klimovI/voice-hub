import { useCallback } from 'react';

// POST /api/logout expires the session cookie; the server has no session
// table so nothing else needs cleaning. The redirect lands on /login.html
// where the user can log back in (or, on Tauri, switch server via the
// adjacent ChangeServerButton).
export function LogoutButton() {
  const handleLogout = useCallback(async () => {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Ignore network errors — cookie may already be invalid; fall through to redirect.
    }
    window.location.replace('/login.html');
  }, []);

  return (
    <button
      type="button"
      onClick={handleLogout}
      title="Выйти"
      aria-label="Выйти"
      className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-bg-3 border border-line-strong text-danger/70 hover:text-danger hover:border-[rgba(248,113,113,0.3)] hover:bg-[rgba(248,113,113,0.08)] transition-colors"
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
