import { useTauriHotkey } from '../hooks/useTauriHotkey';
import { useWebHotkey } from '../hooks/useWebHotkey';
import { isTauri } from '../utils/tauri';
import { HotkeyCardView } from './HotkeyCardView';

type Props = {
  onStatusMessage: (msg: string) => void;
};

export function HotkeyCard({ onStatusMessage }: Props) {
  return isTauri() ? (
    <TauriCard onStatusMessage={onStatusMessage} />
  ) : (
    <WebCard onStatusMessage={onStatusMessage} />
  );
}

function WebCard({ onStatusMessage }: Props) {
  const api = useWebHotkey(onStatusMessage);
  return <HotkeyCardView api={api} />;
}

function TauriCard({ onStatusMessage }: Props) {
  const api = useTauriHotkey(onStatusMessage);
  return <HotkeyCardView api={api} />;
}
