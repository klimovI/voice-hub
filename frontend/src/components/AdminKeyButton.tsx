import { useEffect, useState, useCallback } from 'react';
import { useIsAdmin } from '../hooks/useIsAdmin';

interface ConnPassStatus {
  exists: boolean;
  generation: number;
  rotated_at: string;
}

interface RotateResponse {
  host: string;
  password: string;
  generation: number;
  rotated_at: string;
}

type Mode = 'info' | 'rotated';

const ENDPOINT = '/api/admin/connection-password';

function relativeTime(iso: string): string {
  if (!iso || iso.startsWith('0001-')) return 'никогда';
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 0) return new Date(iso).toLocaleString();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

export function AdminKeyButton() {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('info');
  const [status, setStatus] = useState<ConnPassStatus | null>(null);
  const [rotated, setRotated] = useState<RotateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Once useIsAdmin flips true, fetch the current connection-password status
  // for the initial info panel. Refresh-on-open is handled separately by
  // refreshStatus, so this effect only seeds the first render.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    fetch(ENDPOINT, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((s: ConnPassStatus | null) => {
        if (!cancelled && s) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const refreshStatus = useCallback(async () => {
    const res = await fetch(ENDPOINT, { credentials: 'same-origin' });
    if (res.ok) setStatus(await res.json());
  }, []);

  const handleOpen = useCallback(() => {
    setMode('info');
    setRotated(null);
    setError(null);
    setOpen(true);
    void refreshStatus();
  }, [refreshStatus]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setRotated(null);
    setError(null);
  }, []);

  const handleRotate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT + '/rotate', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setError('Не удалось сгенерировать пароль');
        return;
      }
      const data = (await res.json()) as RotateResponse;
      setRotated(data);
      setMode('rotated');
      setStatus({
        exists: true,
        generation: data.generation,
        rotated_at: data.rotated_at,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRevoke = useCallback(async () => {
    if (!window.confirm('Удалить пароль подключения?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT + '/revoke', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setError('Не удалось удалить');
        return;
      }
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  const handleDisconnectUsers = useCallback(async () => {
    if (!window.confirm('Отключить пользователей?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT + '/disconnect-users', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setError('Не удалось отключить');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; user can select+copy manually.
    }
  }, []);

  if (!isAdmin) return null;

  const shareBlock = rotated ? `Сервер: ${rotated.host}\nПароль: ${rotated.password}` : '';

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title="Управление паролем подключения"
        aria-label="Управление паролем подключения"
        className="inline-flex items-center justify-center w-9 h-9 bg-bg-0 border border-line text-muted-2 hover:text-accent hover:border-accent transition-colors"
      >
        <span className="msym" style={{ fontSize: 18 }}>
          key
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.6)] p-4"
          onClick={handleClose}
        >
          <div
            className="card card-lg w-[min(440px,100%)] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {mode === 'info' && (
              <>
                <h2 className="text-[14px] font-extrabold uppercase tracking-[0.18em] text-text m-0 mb-2">
                  Пароль подключения
                </h2>
                <div className="text-muted text-[12px] mb-5">
                  {status?.exists
                    ? `Создан: ${relativeTime(status.rotated_at)} · поколение #${status.generation}`
                    : 'Не настроен — пользователи не могут войти, пока вы не сгенерируете пароль.'}
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handleRotate}
                    disabled={busy}
                    className="btn btn-primary w-full justify-center"
                  >
                    {status?.exists ? 'Сгенерировать новый' : 'Создать пароль'}
                  </button>
                  {status?.exists && (
                    <button
                      type="button"
                      onClick={handleRevoke}
                      disabled={busy}
                      className="btn w-full justify-center text-danger border-[rgba(248,113,113,0.3)] hover:bg-[rgba(248,113,113,0.08)]"
                    >
                      Удалить пароль
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleDisconnectUsers}
                    disabled={busy}
                    className="btn w-full justify-center text-danger border-[rgba(248,113,113,0.3)] hover:bg-[rgba(248,113,113,0.08)]"
                  >
                    Отключить пользователей
                  </button>
                  <button type="button" onClick={handleClose} className="btn w-full justify-center">
                    Закрыть
                  </button>
                </div>
                {error && (
                  <div className="mt-3 px-3 py-2 text-[12px] text-danger bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.3)]">
                    {error}
                  </div>
                )}
              </>
            )}

            {mode === 'rotated' && rotated && (
              <>
                <h2 className="text-[14px] font-extrabold uppercase tracking-[0.18em] text-accent m-0 mb-2">
                  Новый пароль
                </h2>
                <div className="text-muted text-[12px] mb-4">
                  Скопируйте сейчас — больше не будет показан.
                </div>
                <pre className="px-3 py-2.5 mb-3 bg-bg-0 border border-line text-[12px] font-mono whitespace-pre-wrap break-all text-accent">
                  {shareBlock}
                </pre>
                <div className="flex gap-2 mb-2">
                  <button
                    type="button"
                    className="btn flex-1 justify-center"
                    onClick={() => copy('share', shareBlock)}
                  >
                    {copied === 'share' ? '✓ Скопировано' : 'Копировать всё'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => copy('pw', rotated.password)}
                  >
                    {copied === 'pw' ? '✓' : 'Только пароль'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  className="btn btn-primary w-full justify-center mt-3"
                >
                  Готово
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
