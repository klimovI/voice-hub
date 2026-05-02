import { useEffect, useState } from "react";

export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/connection-password", { credentials: "same-origin" })
      .then((res) => {
        if (cancelled) return;
        if (res.status === 200) setIsAdmin(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return isAdmin;
}
