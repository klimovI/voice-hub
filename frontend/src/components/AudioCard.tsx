import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { clampPercentage } from "../utils/storage";
import { formatRnnoiseMix, formatEngine } from "../utils/clamp";
import type { EngineKind } from "../types";

// Currently only off + RNNoise. New engines slot in by adding to this list
// (and to EngineKind, preloadEngine, and the engine branch in buildMicGraph).
const ENGINES: EngineKind[] = ["off", "rnnoise"];

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
    <div className="flex justify-between gap-3 items-center text-[13px]">
      <span className="text-muted">{label}</span>
      <strong className="font-bold tabular-nums text-[12px] px-2 py-0.5 text-accent bg-[rgba(34,197,94,0.16)] border border-accent rounded-full">
        {value}
      </strong>
    </div>
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
              d.kind === "audioinput" &&
              d.deviceId &&
              d.deviceId !== "default" &&
              d.deviceId !== "communications",
          ),
        );
      } catch {
        // enumerateDevices can throw in restricted contexts; leave list empty.
      }
    };
    void refresh();
    md.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      md.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // Drop the selected device if it disappeared (unplugged, permission revoked).
  useEffect(() => {
    if (!micDeviceId || micDevices.length === 0) return;
    const stillPresent = micDevices.some((d) => d.deviceId === micDeviceId);
    if (!stillPresent) onMicDeviceSelect(null);
  }, [micDeviceId, micDevices, onMicDeviceSelect]);

  // Hide picker when there is at most one input device — picker would be noise.
  // Labels are empty strings until the user grants mic permission, so before
  // first join the list still renders but with placeholder labels.
  const showMicPicker = micDevices.length > 1;

  return (
    <section className="card grid gap-[14px]">
      <div className="flex items-center justify-between gap-3 mb-2">
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
          <label htmlFor="mic-device" className="text-[13px] text-muted">
            Микрофон
          </label>
          <select
            id="mic-device"
            value={micDeviceId ?? ""}
            onChange={(e) => onMicDeviceSelect(e.target.value || null)}
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%239aa8a2' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 14px center",
            }}
            className="appearance-none w-full pl-3 pr-10 py-2 text-[13px] bg-bg-input border border-line rounded-[10px] text-text cursor-pointer hover:border-muted-2 focus:outline-none focus:border-accent transition-colors duration-100"
          >
            <option value="">Системный по умолчанию</option>
            {micDevices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Микрофон ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid gap-2">
        <span className="text-[13px] text-muted">Шумоподавление</span>
        <div
          id="denoiser-engine"
          role="radiogroup"
          aria-label="Шумоподавление"
          className="grid gap-1.5 p-1 bg-bg-input border border-line rounded-[14px]"
          style={{ gridTemplateColumns: `repeat(${ENGINES.length}, minmax(0, 1fr))` }}
        >
          {ENGINES.map((eng) => {
            const active = engine === eng;
            return (
              <button
                key={eng}
                type="button"
                data-engine={eng}
                role="radio"
                aria-checked={active ? "true" : "false"}
                onClick={() => onEngineSelect(eng)}
                className={`flex justify-center items-center w-full px-2.5 py-2 text-[12px] font-semibold rounded-[10px] cursor-pointer border transition-[background,color,border-color] duration-100 ${
                  active
                    ? "bg-accent text-accent-ink border-accent"
                    : "bg-transparent border-transparent text-muted hover:bg-bg-3 hover:text-text"
                }`}
              >
                {formatEngine(eng)}
              </button>
            );
          })}
        </div>
      </div>

      {engine === "rnnoise" && (
        <div className="grid gap-2">
          <SliderHead label="Сила подавления" value={formatRnnoiseMix(rnnoiseMix)} />
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
