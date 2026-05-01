import { useState, useRef } from "react";
import "./styles/login.css";

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
    <main className="card">
      <div className="brand">
        <span className="dot" />
        Voice Hub
      </div>
      <h1>Вход</h1>
      <div className="sub">Введите общий логин и пароль.</div>
      <form id="login-form" ref={formRef} method="post" action="/api/login" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="user">Логин</label>
          <input id="user" name="user" autoComplete="username" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" id="submit" disabled={submitting}>
          Войти
        </button>
        {error && <div className={`error show`}>{error}</div>}
      </form>
    </main>
  );
}
