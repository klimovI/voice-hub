// Browser tab attention cue: swap favicon to alert variant until window gains
// focus. No-op when window is already focused (user is looking).

const ALERT_SRC = '/favicon-alert.svg';
const NORMAL_SRC = '/favicon.svg';

let active = false;

function getLink(): HTMLLinkElement | null {
  return document.querySelector("link[rel='icon'][type='image/svg+xml']");
}

function setIcon(src: string): void {
  const l = getLink();
  if (l) l.href = src;
}

window.addEventListener('focus', () => {
  if (!active) return;
  setIcon(NORMAL_SRC);
  active = false;
});

export function flashFavicon(): void {
  if (document.hasFocus()) return;
  setIcon(ALERT_SRC);
  active = true;
}
