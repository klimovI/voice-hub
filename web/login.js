const form = document.getElementById("login-form");
const submit = document.getElementById("submit");
const errorEl = document.getElementById("error");

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("show");
}

function clearError() {
  errorEl.classList.remove("show");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  submit.disabled = true;
  try {
    const body = new URLSearchParams();
    body.set("user", form.user.value);
    body.set("password", form.password.value);
    const res = await fetch("/api/login", {
      method: "POST",
      body,
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (res.status === 204) {
      const next = new URLSearchParams(window.location.search).get("next") || "/";
      window.location.replace(next);
      return;
    }
    if (res.status === 429) {
      showError("Слишком много попыток. Подождите 15 минут.");
      return;
    }
    showError("Неверный логин или пароль.");
  } catch (err) {
    showError("Сетевая ошибка: " + err.message);
  } finally {
    submit.disabled = false;
  }
});
