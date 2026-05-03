import { useStore } from "../store/useStore";
import { clampPercentage } from "../utils/storage";
import { formatRnnoiseMix, formatEngine } from "../utils/clamp";
import type { EngineKind } from "../types";

const ENGINES: EngineKind[] = ["off", "rnnoise", "dtln"];

interface Props {
  onEngineSelect: (engine: EngineKind) => void;
  onSendVolumeChange: (v: number) => void;
  onRnnoiseMixChange: (v: number) => void;
  onOutputVolumeChange: (v: number) => void;
  onOutputMuteToggle: () => void;
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
  onSendVolumeChange,
  onRnnoiseMixChange,
  onOutputVolumeChange,
  onOutputMuteToggle,
  onReset,
}: Props) {
  const engine = useStore((s) => s.engine);
  const sendVolume = useStore((s) => s.sendVolume);
  const rnnoiseMix = useStore((s) => s.rnnoiseMix);
  const outputVolume = useStore((s) => s.outputVolume);
  const outputMuted = useStore((s) => s.outputMuted);

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

      <div className="grid gap-2">
        <span className="text-[13px] text-muted">Шумоподавление</span>
        <div
          id="denoiser-engine"
          role="radiogroup"
          aria-label="Движок шумоподавления"
          className="grid grid-cols-3 gap-1.5 p-1 bg-bg-input border border-line rounded-[14px]"
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

      <div className="grid gap-2">
        <SliderHead label="Сила подавления" value={formatRnnoiseMix(rnnoiseMix)} />
        <input
          id="rnnoise-mix"
          type="range"
          min="0"
          max="100"
          step="5"
          value={rnnoiseMix}
          disabled={engine !== "rnnoise"}
          onChange={(e) => onRnnoiseMixChange(clampPercentage(e.target.value))}
          className="vh-range"
        />
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
        <div className="flex flex-wrap gap-2.5 mt-1.5">
          <button
            id="output-mute-button"
            type="button"
            aria-pressed={outputMuted ? "true" : "false"}
            onClick={onOutputMuteToggle}
            className={`btn btn-mini ${outputMuted ? "btn-toggle-on" : "btn-secondary"}`}
          >
            {outputMuted ? "Включить звук" : "Выключить звук"}
          </button>
        </div>
      </div>
    </section>
  );
}
