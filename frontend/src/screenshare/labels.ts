export function formatQualityLabel(w: number, h: number): string {
  return `${w}×${h}`;
}

export function formatFpsLabel(fps: number): string {
  return `${Math.round(fps)}fps`;
}
