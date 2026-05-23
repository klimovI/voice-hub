import { useEffect, useState, useCallback } from 'react';
import { Key, Plus, RefreshCw, Trash2, Edit2, Check, X, Clock } from 'lucide-react';
import { useIsAdmin } from '../hooks/useIsAdmin';

interface ConnPassEntry {
  id: string;
  label: string;
  generation: number;
  created_at: string;
  expires_at?: string;
  expired: boolean;
}

interface ConnPassStatus {
  entries: ConnPassEntry[];
}

interface PlaintextResponse {
  host: string;
  id: string;
  label: string;
  password: string;
  generation: number;
  created_at: string;
  expires_at?: string;
  expired: boolean;
}

type Mode = 'list' | 'plaintext';

const ENDPOINT = '/api/admin/connection-passwords';
const MAX_ENTRIES = 16;

const TTL_PRESETS: readonly { value: number; label: string }[] = [
  { value: 0, label: 'без срока' },
  { value: 60 * 60, label: '1 час' },
  { value: 24 * 60 * 60, label: '1 день' },
  { value: 7 * 24 * 60 * 60, label: '7 дней' },
  { value: 30 * 24 * 60 * 60, label: '30 дней' },
  { value: -1, label: 'отключить сейчас' },
];

function expiryLabel(entry: ConnPassEntry): string {
  if (!entry.expires_at || entry.expires_at.startsWith('0001-')) return 'без срока';
  if (entry.expired) return 'просрочен';
  const ms = new Date(entry.expires_at).getTime() - Date.now();
  if (ms <= 0) return 'просрочен';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `< ${mins} мин`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `< ${hours} ч`;
  const days = Math.floor(hours / 24);
  return `< ${days} дн`;
}

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
  const [mode, setMode] = useState<Mode>('list');
  const [entries, setEntries] = useState<ConnPassEntry[]>([]);
  const [plaintext, setPlaintext] = useState<PlaintextResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newTTL, setNewTTL] = useState<number>(0);
  const [renamingID, setRenamingID] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [ttlEditingID, setTtlEditingID] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT, { credentials: 'same-origin' });
      if (res.ok) {
        const data = (await res.json()) as ConnPassStatus;
        setEntries(data.entries ?? []);
      }
    } catch (err) {
      console.warn('[admin-key] refresh status failed:', err);
    }
  }, []);

  // Seed the entry list once useIsAdmin flips true so the badge in the trigger
  // can later show counts without opening the modal. Refresh-on-open is handled
  // separately by refreshStatus.
  useEffect(() => {
    if (!isAdmin) return;
    void refreshStatus();
  }, [isAdmin, refreshStatus]);

  const handleOpen = useCallback(() => {
    setMode('list');
    setPlaintext(null);
    setError(null);
    setNewLabel('');
    setRenamingID(null);
    setOpen(true);
    void refreshStatus();
  }, [refreshStatus]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setPlaintext(null);
    setError(null);
    setRenamingID(null);
  }, []);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim(), ttl_seconds: newTTL }),
      });
      if (!res.ok) {
        if (res.status === 409) setError('Достигнут лимит паролей');
        else setError('Не удалось создать пароль');
        return;
      }
      const data = (await res.json()) as PlaintextResponse;
      setPlaintext(data);
      setMode('plaintext');
      setNewLabel('');
      setNewTTL(0);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [newLabel, newTTL, refreshStatus]);

  const handleSetTTL = useCallback(
    async (id: string, ttlSeconds: number) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${id}/ttl`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl_seconds: ttlSeconds }),
        });
        if (!res.ok) {
          setError('Не удалось обновить срок');
          return;
        }
        setTtlEditingID(null);
        await refreshStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refreshStatus],
  );

  const handleRotate = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${id}/rotate`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          setError('Не удалось перегенерировать');
          return;
        }
        const data = (await res.json()) as PlaintextResponse;
        setPlaintext(data);
        setMode('plaintext');
        await refreshStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refreshStatus],
  );

  const handleRevoke = useCallback(
    async (id: string, label: string) => {
      const what = label ? `«${label}»` : 'этот пароль';
      if (!window.confirm(`Удалить ${what}?`)) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${id}`, {
          method: 'DELETE',
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
    },
    [refreshStatus],
  );

  const handleRename = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${id}/rename`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: renameValue.trim() }),
        });
        if (!res.ok) {
          setError('Не удалось переименовать');
          return;
        }
        setRenamingID(null);
        await refreshStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [renameValue, refreshStatus],
  );

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

  const shareBlock = plaintext ? `Сервер: ${plaintext.host}\nПароль: ${plaintext.password}` : '';
  const atLimit = entries.length >= MAX_ENTRIES;

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title="Управление паролями подключения"
        aria-label="Управление паролями подключения"
        className="inline-flex items-center justify-center w-9 h-9 bg-bg-0 border border-line text-muted-2 hover:text-accent hover:border-accent transition-colors"
      >
        <Key size={18} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.6)] p-4"
          onClick={handleClose}
        >
          <div
            className="card card-lg w-[min(520px,100%)] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {mode === 'list' && (
              <>
                <h2 className="text-[14px] font-extrabold uppercase tracking-[0.18em] text-text m-0 mb-2">
                  Пароли подключения
                </h2>
                <div className="text-muted text-[12px] mb-4">
                  {entries.length === 0
                    ? 'Нет активных паролей — пользователи не могут войти.'
                    : `Активных: ${entries.length} из ${MAX_ENTRIES}`}
                </div>

                {entries.length > 0 && (
                  <div className="flex flex-col gap-2 mb-4">
                    {entries.map((entry) => (
                      <div
                        key={entry.id}
                        className={`flex items-center gap-2 px-3 py-2 bg-bg-0 border ${entry.expired ? 'border-[rgba(248,113,113,0.3)] opacity-60' : 'border-line'}`}
                      >
                        <div className="flex-1 min-w-0">
                          {renamingID === entry.id ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void handleRename(entry.id);
                                  if (e.key === 'Escape') setRenamingID(null);
                                }}
                                maxLength={64}
                                className="flex-1 bg-bg-1 border border-line px-2 py-1 text-[12px] text-text focus:border-accent outline-none"
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() => void handleRename(entry.id)}
                                disabled={busy}
                                className="p-1 text-accent hover:bg-[rgba(255,255,255,0.04)]"
                                title="Сохранить"
                              >
                                <Check size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenamingID(null)}
                                className="p-1 text-muted hover:bg-[rgba(255,255,255,0.04)]"
                                title="Отмена"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          ) : (
                            <>
                              <div className="text-text text-[13px] font-medium truncate">
                                {entry.label || <span className="text-muted-2 italic">без названия</span>}
                              </div>
                              <div className="text-muted-2 text-[11px] flex items-center gap-1.5">
                                <span>{relativeTime(entry.created_at)} · #{entry.generation}</span>
                                <span className={entry.expired ? 'text-danger' : ''}>· {expiryLabel(entry)}</span>
                              </div>
                            </>
                          )}
                        </div>
                        {renamingID !== entry.id && ttlEditingID !== entry.id && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => setTtlEditingID(entry.id)}
                              disabled={busy}
                              className="p-1.5 text-muted-2 hover:text-text hover:bg-[rgba(255,255,255,0.04)]"
                              title="Изменить срок"
                            >
                              <Clock size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingID(entry.id);
                                setRenameValue(entry.label);
                              }}
                              disabled={busy}
                              className="p-1.5 text-muted-2 hover:text-text hover:bg-[rgba(255,255,255,0.04)]"
                              title="Переименовать"
                            >
                              <Edit2 size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRotate(entry.id)}
                              disabled={busy}
                              className="p-1.5 text-muted-2 hover:text-accent hover:bg-[rgba(255,255,255,0.04)]"
                              title="Перегенерировать"
                            >
                              <RefreshCw size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleRevoke(entry.id, entry.label)}
                              disabled={busy}
                              className="p-1.5 text-muted-2 hover:text-danger hover:bg-[rgba(248,113,113,0.08)]"
                              title="Удалить"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )}
                        {ttlEditingID === entry.id && (
                          <div className="flex items-center gap-1 shrink-0">
                            <select
                              defaultValue=""
                              disabled={busy}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                if (!Number.isNaN(v)) void handleSetTTL(entry.id, v);
                              }}
                              className="bg-bg-1 border border-line px-2 py-1 text-[12px] text-text focus:border-accent outline-none"
                              autoFocus
                            >
                              <option value="" disabled>Срок…</option>
                              {TTL_PRESETS.map((p) => (
                                <option key={p.value} value={p.value}>
                                  {p.label}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => setTtlEditingID(null)}
                              className="p-1 text-muted hover:bg-[rgba(255,255,255,0.04)]"
                              title="Отмена"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !atLimit) void handleCreate();
                    }}
                    placeholder="Название (необязательно)"
                    maxLength={64}
                    disabled={busy || atLimit}
                    className="flex-1 bg-bg-0 border border-line px-3 py-2 text-[13px] text-text placeholder:text-muted-2 focus:border-accent outline-none disabled:opacity-50"
                  />
                  <select
                    value={newTTL}
                    onChange={(e) => setNewTTL(Number(e.target.value))}
                    disabled={busy || atLimit}
                    className="bg-bg-0 border border-line px-2 py-2 text-[13px] text-text focus:border-accent outline-none disabled:opacity-50"
                    title="Срок действия"
                  >
                    {TTL_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={busy || atLimit}
                    className="btn btn-primary inline-flex items-center gap-1.5"
                    title={atLimit ? 'Достигнут лимит паролей' : 'Создать пароль'}
                  >
                    <Plus size={14} />
                    Создать
                  </button>
                </div>

                <div className="flex flex-col gap-2">
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

            {mode === 'plaintext' && plaintext && (
              <>
                <h2 className="text-[14px] font-extrabold uppercase tracking-[0.18em] text-accent m-0 mb-2">
                  Новый пароль{plaintext.label ? ` · ${plaintext.label}` : ''}
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
                    onClick={() => copy('pw', plaintext.password)}
                  >
                    {copied === 'pw' ? '✓' : 'Только пароль'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setMode('list')}
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
