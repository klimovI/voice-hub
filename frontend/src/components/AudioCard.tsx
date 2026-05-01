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
    <section className="card controls">
      <div className="card-head">
        <h2 className="card-title">Audio</h2>
        <button
          id="audio-reset"
          className="secondary mini-button"
          type="button"
          onClick={onReset}
        >
          Reset
        </button>
      </div>

      <div className="engine-row">
        <span className="engine-label">Denoiser</span>
        <div
          id="denoiser-engine"
          className="engine-toggle"
          role="radiogroup"
          aria-label="Denoiser engine"
        >
          {ENGINES.map((eng) => (
            <button
              key={eng}
              type="button"
              className="engine-opt"
              data-engine={eng}
              role="radio"
              aria-checked={engine === eng ? "true" : "false"}
              onClick={() => onEngineSelect(eng)}
            >
              {formatEngine(eng)}
            </button>
          ))}
        </div>
      </div>

      <div className="slider-row">
        <div className="slider-head">
          <span>Suppression strength</span>
          <strong id="rnnoise-mix-value">{formatRnnoiseMix(rnnoiseMix)}</strong>
        </div>
        <input
          id="rnnoise-mix"
          type="range"
          min="0"
          max="100"
          step="5"
          value={rnnoiseMix}
          disabled={engine !== "rnnoise"}
          onChange={(e) => onRnnoiseMixChange(clampPercentage(e.target.value))}
        />
      </div>

      <div className="slider-row">
        <div className="slider-head">
          <span>Mic send volume</span>
          <strong id="send-volume-value">{sendVolume}%</strong>
        </div>
        <input
          id="send-volume"
          type="range"
          min="0"
          max="300"
          step="5"
          value={sendVolume}
          onChange={(e) => onSendVolumeChange(Number(e.target.value))}
        />
      </div>

      <div className="slider-row">
        <div className="slider-head">
          <span>Master output</span>
          <strong id="output-volume-value">{outputVolume}%</strong>
        </div>
        <input
          id="output-volume"
          type="range"
          min="0"
          max="200"
          step="5"
          value={outputVolume}
          onChange={(e) => onOutputVolumeChange(Number(e.target.value))}
        />
        <div className="inline-actions" style={{ marginTop: 6 }}>
          <button
            id="output-mute-button"
            className="secondary mini-button"
            type="button"
            aria-pressed={outputMuted ? "true" : "false"}
            onClick={onOutputMuteToggle}
          >
            {outputMuted ? "Unmute Output" : "Mute Output"}
          </button>
        </div>
      </div>
    </section>
  );
}
