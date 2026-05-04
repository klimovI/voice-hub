import { useStore } from '../store/useStore';

export function useIsAdmin(): boolean {
  return useStore((s) => s.role === 'admin');
}
