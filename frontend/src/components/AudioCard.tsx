import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import type { EngineKind } from '../types';
import { DENOISERS, DENOISER_IDS } from '../audio/denoisers/registry';
import type { DenoiserId } from '../audio/denoisers/types';
import { startMicTest, type MicTestHandle } from '../audio/mic-test';
import { detectLevel } from '../audio/level-detect';

type DenoiserVariant = DenoiserId;

const VARIANT_OPTIONS: { value: DenoiserVariant; label: string }[] = DENOISER_IDS.map((id) => ({
  value: id,
  label: DENOISERS[id].label,
}));

interface Props {
  onEngineSelect: (engine: EngineKind) => void;
  onMicDeviceSelect: (deviceId: string | null) => void;
  onSendVolumeChange: (v: number) => void;
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
  onOutputVolumeChange,
  onReset,
}: Props) {
  const engine = useStore((s) => s.engine);
  const sendVolume = useStore((s) => s.sendVolume);
  const outputVolume = useStore((s) => s.outputVolume);
  const micDeviceId = useStore((s) => s.micDeviceId);
  const joinState = useStore((s) => s.joinState);
  const setStatus = useStore((s) => s.setStatus);
  const voiceActive = joinState === 'joined' || joinState === 'joining';

  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [testActive, setTestActive] = useState(false);
  const [testLevel, setTestLevel] = useState(0);
  const testHandleRef = useRef<MicTestHandle | null>(null);
  const testTimeoutRef = useRef<number | null>(null);
  const testRafRef = useRef<number | null>(null);
  // Remembers the last non-off engine so toggling the switch back on restores
  // the chosen variant rather than resetting to the default.
  const [lastVariant, setLastVariant] = useState<DenoiserVariant>(
    engine === 'off' ? 'rnnoise-v2' : engine,
  );
  useEffect(() => {
    if (engine !== 'off') setLastVariant(engine);
  }, [engine]);

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

  const startGenRef = useRef(0);

  const stopTest = useCallback(() => {
    startGenRef.current += 1;
    if (testTimeoutRef.current !== null) {
      window.clearTimeout(testTimeoutRef.current);
      testTimeoutRef.current = null;
    }
    if (testRafRef.current !== null) {
      cancelAnimationFrame(testRafRef.current);
      testRafRef.current = null;
    }
    testHandleRef.current?.stop();
    testHandleRef.current = null;
    setTestActive(false);
    setTestLevel(0);
  }, []);

  const startTest = async () => {
    if (testHandleRef.current) return;
    if (voiceActive) {
      setStatus('Тест микрофона недоступен во время голосового подключения.', true);
      return;
    }
    const gen = ++startGenRef.current;
    try {
      const handle = await startMicTest(engine, () => useStore.getState().sendVolume, micDeviceId);
      if (gen !== startGenRef.current) {
        handle.stop();
        return;
      }
      testHandleRef.current = handle;
      setTestActive(true);
      testTimeoutRef.current = window.setTimeout(stopTest, 30000);
      const tick = () => {
        const g = testHandleRef.current?.graph;
        if (!g) return;
        setTestLevel(detectLevel(g.localMonitorAnalyser, g.localMonitorData));
        testRafRef.current = requestAnimationFrame(tick);
      };
      testRafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      if (gen !== startGenRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Не удалось начать тест микрофона: ${msg}`, true);
    }
  };

  useEffect(() => {
    if (testHandleRef.current) stopTest();
  }, [engine, micDeviceId, stopTest]);

  useEffect(() => {
    if (voiceActive) stopTest();
  }, [voiceActive, stopTest]);

  useEffect(() => stopTest, [stopTest]);

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

      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="section-label">Шумоподавление</span>
          <Toggle
            checked={engine !== 'off'}
            onChange={() => onEngineSelect(engine === 'off' ? lastVariant : 'off')}
            ariaLabel="Шумоподавление"
          />
        </div>

        {engine !== 'off' && (
          <div className="grid gap-2">
            <label htmlFor="engine-variant" className="section-label">
              Алгоритм
            </label>
            <div className="relative">
              <select
                id="engine-variant"
                value={engine}
                onChange={(e) => onEngineSelect(e.target.value as DenoiserVariant)}
                className="appearance-none w-full pl-3 pr-9 py-2.5 text-[13px] uppercase tracking-[0.1em]
                  bg-bg-input border border-line text-body cursor-pointer
                  hover:border-muted-2 focus:outline-none focus:border-accent transition-colors"
              >
                {VARIANT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
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
      </div>

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
        <button
          type="button"
          onClick={testActive ? stopTest : startTest}
          className="btn btn-secondary"
          aria-pressed={testActive}
          disabled={voiceActive}
          title={voiceActive ? 'Выйдите из голосового чата перед тестом микрофона' : undefined}
        >
          {testActive ? 'Остановить тест' : 'Тест микрофона'}
        </button>
        {testActive && (
          <>
            <div
              className="h-1 bg-bg-input border border-line overflow-hidden"
              role="meter"
              aria-label="Уровень микрофона"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.round(testLevel * 400))}
            >
              <div
                className="h-full bg-accent transition-[width] duration-75"
                style={{ width: `${Math.min(100, testLevel * 400)}%` }}
              />
            </div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-muted">
              Используйте наушники для точного теста
            </p>
          </>
        )}
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
