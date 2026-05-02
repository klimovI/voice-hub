export const REJOIN_ON_LOAD_KEY = "voice-hub.rejoin-on-load";

export function consumeRejoinFlag(): boolean {
  if (localStorage.getItem(REJOIN_ON_LOAD_KEY) !== "1") return false;
  localStorage.removeItem(REJOIN_ON_LOAD_KEY);
  return true;
}
