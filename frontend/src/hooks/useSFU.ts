import { useRef, useCallback } from 'react';
import { createSFUClient, type SFUClient } from '../sfu/client';

export function useSFU() {
  const clientRef = useRef<SFUClient | null>(null);

  const getClient = useCallback(() => clientRef.current, []);

  const createClient = useCallback((handlers: Parameters<typeof createSFUClient>[0]) => {
    const client = createSFUClient(handlers);
    clientRef.current = client;
    return client;
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  const getPeerConnection = useCallback(() => {
    return clientRef.current?.getPeerConnection() ?? null;
  }, []);

  return { getClient, createClient, disconnect, getPeerConnection };
}
