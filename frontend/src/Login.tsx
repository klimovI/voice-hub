import { useState, useRef } from "react";
import "./styles/main.css";

export function Login() {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const form = e.currentTarget;
    const body = new URLSearchParams();
    const userInput = form.elements.namedItem("user") as HTMLInputElement;
    const passwordInput = form.elements.namedItem("password") as HTMLInputElement;
    body.set("user", userInput.value);
    body.set("password", passwordInput.value);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        body,
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (res.status === 204) {
        window.location.replace("/");
        return;
      }
      if (res.status === 429) {
        setError("Слишком много попыток. Подождите 15 минут.");
        return;
      }
      setError("Неверный логин или пароль.");
    } catch (err) {
      setError("Сетевая ошибка: " + (err instanceof Error ? err.message : String(err)));
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
      <h1 className="text-[20px] font-semibold m-0 mb-1 tracking-[-0.01em]">Вход</h1>
      <div className="text-muted text-[13px] mb-5">Введите общий логин и пароль.</div>
      <form id="login-form" ref={formRef} method="post" action="/api/login" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="user" className="block text-[12px] font-medium text-muted mb-1.5">
            Логин
          </label>
          <input
            id="user"
            name="user"
            autoComplete="username"
            required
            autoFocus
            className="input-field !mt-0"
          />
        </div>
        <div className="mt-3.5">
          <label htmlFor="password" className="block text-[12px] font-medium text-muted mb-1.5">
            Пароль
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="input-field !mt-0"
          />
        </div>
        <button
          type="submit"
          id="submit"
          disabled={submitting}
          className="btn btn-primary w-full justify-center mt-5 disabled:cursor-progress disabled:opacity-60"
        >
          Войти
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
