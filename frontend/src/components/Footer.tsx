import { useEffect, useState } from 'react';
import { isTauri } from '../utils/tauri';

interface Props {
  uiVersion: string | null;
}

export function Footer({ uiVersion }: Props) {
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void import('@tauri-apps/api/app').then(({ getVersion }) =>
      getVersion().then((v) => {
        if (!cancelled) setAppVersion(v);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!uiVersion && !appVersion) return null;

  const parts: string[] = [];
  if (appVersion) parts.push(`Voice Hub ${appVersion}`);
  if (uiVersion) parts.push(`ui ${uiVersion}`);

  return (
    <footer className="text-center text-[11px] font-bold uppercase tracking-[0.18em] text-muted-2 select-text">
      {parts.join(' · ')}
    </footer>
  );
}
