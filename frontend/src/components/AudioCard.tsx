import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { clampPercentage } from '../utils/storage';
import { formatRnnoiseMix } from '../utils/clamp';
import type { EngineKind } from '../types';

interface Props {
  onEngineSelect: (engine: EngineKind) => void;
  onMicDeviceSelect: (deviceId: string | null) => void;
  onSendVolumeChange: (v: number) => void;
  onRnnoiseMixChange: (v: number) => void;
  onOutputVolumeChange: (v: number) => void;
  onReset: () => void;
}

function SliderHead({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center text-[13px] font-bold uppercase tracking-[0.18em]">
      <span className="text-muted">{label}</span>
      <span className="text-accent tabular-nums">{value}</span>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className="vh-toggle"
      data-checked={checked}
    >
      <span className="vh-toggle-dot" />
    </button>
  );
}

export function AudioCard({
  onEngineSelect,
  onMicDeviceSelect,
  onSendVolumeChange,
  onRnnoiseMixChange,
  onOutputVolumeChange,
  onReset,
}: Props) {
  const engine = useStore((s) => s.engine);
  const sendVolume = useStore((s) => s.sendVolume);
  const rnnoiseMix = useStore((s) => s.rnnoiseMix);
  const outputVolume = useStore((s) => s.outputVolume);
  const micDeviceId = useStore((s) => s.micDeviceId);

  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await md.enumerateDevices();
        if (cancelled) return;
        setMicDevices(
          all.filter(
            (d) =>
              d.kind === 'audioinput' &&
              d.deviceId &&
              d.deviceId !== 'default' &&
              d.deviceId !== 'communications',
          ),
        );
      } catch {
        // enumerateDevices can throw in restricted contexts; leave list empty.
      }
    };
    void refresh();
    md.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      md.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  // Drop the selected device if it disappeared (unplugged, permission revoked).
  useEffect(() => {
    if (!micDeviceId || micDevices.length === 0) return;
    const stillPresent = micDevices.some((d) => d.deviceId === micDeviceId);
    if (!stillPresent) onMicDeviceSelect(null);
  }, [micDeviceId, micDevices, onMicDeviceSelect]);

  const showMicPicker = micDevices.length > 1;

  return (
    <section className="card grid gap-5 p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="card-title">Звук</h2>
        <button
          id="audio-reset"
          type="button"
          onClick={onReset}
          className="btn btn-secondary btn-mini"
        >
          Сбросить
        </button>
      </div>

      {showMicPicker && (
        <div className="grid gap-2">
          <label htmlFor="mic-device" className="section-label">
            Микрофон
          </label>
          <div className="relative">
            <select
              id="mic-device"
              value={micDeviceId ?? ''}
              onChange={(e) => onMicDeviceSelect(e.target.value || null)}
              className="appearance-none w-full pl-3 pr-9 py-2.5 text-[13px] uppercase tracking-[0.1em]
                bg-bg-input border border-line text-body cursor-pointer
                hover:border-muted-2 focus:outline-none focus:border-accent transition-colors"
            >
              <option value="">Системный по умолчанию</option>
              {micDevices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Микрофон ${i + 1}`}
                </option>
              ))}
            </select>
            <span
              aria-hidden
              className="msym absolute right-2 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none"
              style={{ fontSize: 16 }}
            >
              expand_more
            </span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 py-3">
        <span className="section-label">Шумоподавление</span>
        <Toggle
          checked={engine !== 'off'}
          onChange={() => onEngineSelect(engine === 'off' ? 'rnnoise' : 'off')}
          ariaLabel="Шумоподавление"
        />
      </div>

      {engine === 'rnnoise' && (
        <div className="grid gap-2">
          <SliderHead label="Уровень" value={formatRnnoiseMix(rnnoiseMix)} />
          <input
            id="rnnoise-mix"
            type="range"
            min="0"
            max="100"
            step="5"
            value={rnnoiseMix}
            onChange={(e) => onRnnoiseMixChange(clampPercentage(e.target.value))}
            className="vh-range"
          />
        </div>
      )}

      <div className="grid gap-2">
        <SliderHead label="Громкость микрофона" value={`${sendVolume}%`} />
        <input
          id="send-volume"
          type="range"
          min="0"
          max="300"
          step="5"
          value={sendVolume}
          onChange={(e) => onSendVolumeChange(Number(e.target.value))}
          className="vh-range"
        />
      </div>

      <div className="grid gap-2">
        <SliderHead label="Общая громкость" value={`${outputVolume}%`} />
        <input
          id="output-volume"
          type="range"
          min="0"
          max="300"
          step="5"
          value={outputVolume}
          onChange={(e) => onOutputVolumeChange(Number(e.target.value))}
          className="vh-range"
        />
      </div>
    </section>
  );
}
