// Browser tab attention cue: swap favicon to alert variant for ~4s.
// No-op if the SVG link isn't found.

const ALERT_SRC = '/favicon-alert.svg';
const NORMAL_SRC = '/favicon.svg';
const DURATION_MS = 4000;

let timer: number | null = null;

function getLink(): HTMLLinkElement | null {
  return document.querySelector("link[rel='icon'][type='image/svg+xml']");
}

export function flashFavicon(): void {
  const l = getLink();
  if (l) l.href = ALERT_SRC;
  if (timer !== null) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    if (l) l.href = NORMAL_SRC;
  }, DURATION_MS);
}
