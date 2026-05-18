export function formatQualityLabel(h: number): string {
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 680) return '720p';
  if (h >= 400) return '480p';
  return `${h}p`;
}
