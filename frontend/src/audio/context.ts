export function resolveAudioContextCtor(): typeof AudioContext {
  return (
    (window as Window & typeof globalThis).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}
