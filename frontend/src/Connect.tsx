import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./styles/main.css";

interface ConnectionState {
  has_host: boolean;
  host: string | null;
}

export function Connect() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Pre-fill the saved host so "Change server" doesn't make the user retype.
  useEffect(() => {
    void invoke<ConnectionState>("get_state").then((state) => {
      if (state.host) setHost(state.host);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await invoke("set_host", { host });
      // Rust navigated the webview; nothing else to do here.
    } catch (err) {
      setError(typeof err === "string" ? err : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="card w-[min(380px,100%)] p-7 mx-auto mt-[max(20vh,24px)]">
      <div className="flex items-center gap-2.5 mb-5 font-semibold text-[16px] tracking-[-0.01em]">
        <img
          src="/favicon.svg"
          alt=""
          className="w-7 h-7 rounded-[8px] shadow-[0_6px_22px_-8px_rgba(34,197,94,0.55)]"
        />
        Voice Hub
      </div>
      <h1 className="text-[20px] font-semibold m-0 mb-1 tracking-[-0.01em]">Подключение</h1>
      <div className="text-muted text-[13px] mb-5">
        Введите адрес сервера, который дал администратор. Пароль попросят на следующем шаге.
      </div>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="host" className="block text-[12px] font-medium text-muted mb-1.5">
            Сервер
          </label>
          <input
            id="host"
            name="host"
            ref={inputRef}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="vh.example.com"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
            className="input-field !mt-0"
          />
        </div>
        <button
          type="submit"
          disabled={submitting || !host.trim()}
          className="btn btn-primary w-full justify-center mt-5 disabled:cursor-progress disabled:opacity-60"
        >
          Подключиться
        </button>
        {error && (
          <div className="mt-3.5 px-3 py-2.5 text-[13px] text-danger bg-[rgba(248,113,113,0.12)] border border-[rgba(248,113,113,0.3)] rounded-[14px]">
            {error}
          </div>
        )}
      </form>
    </main>
  );
}
