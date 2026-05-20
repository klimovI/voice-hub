import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  useEffectiveScreenSettings,
  useScreenShareSettingsStore,
} from '../store/useScreenShareSettingsStore';
import { useScreenShareStore } from '../store/useScreenShareStore';
import {
  SCREEN_CODEC_OPTIONS,
  SCREEN_FPS_OPTIONS,
  SCREEN_PRESETS,
  SCREEN_RESOLUTIONS,
  SHARE_MODES,
  type ScreenCodecPref,
  type ScreenFps,
  type ScreenMode,
  type ScreenResolution,
  type ShareMode,
} from '../screenshare/params';

interface Props {
  onLiveUpdate?: () => void | Promise<void>;
  onShareModeChange?: (mode: ShareMode) => void | Promise<void>;
}

const SHARE_MODE_LABELS: Record<ShareMode, string> = {
  sharp: 'Чёткость',
  motion: 'Плавность',
};

const RESOLUTION_LABELS: Record<ScreenResolution, string> = {
  source: 'Источник',
  '720': '720p',
  '1080': '1080p',
  '1440': '1440p (2K)',
  '2160': '2160p (4K)',
};

const CODEC_LABELS: Record<ScreenCodecPref, string> = {
  av1: 'AV1 (рекомендуется)',
  vp9: 'VP9',
};

function fpsLabel(f: ScreenFps): string {
  return `${f} fps`;
}

export function ScreenShareSettings({ onLiveUpdate, onShareModeChange }: Props) {
  const mode = useScreenShareSettingsStore((s) => s.mode);
  const effective = useEffectiveScreenSettings();
  const setMode = useScreenShareSettingsStore((s) => s.setMode);
  const setShareMode = useScreenShareSettingsStore((s) => s.setShareMode);
  const setCodec = useScreenShareSettingsStore((s) => s.setCodec);
  const setResolution = useScreenShareSettingsStore((s) => s.setResolution);
  const setFps = useScreenShareSettingsStore((s) => s.setFps);
  const publishing = useScreenShareStore((s) => s.myStatus === 'publishing');

  // Re-apply resolution/fps/shareMode live when settings change while
  // publishing. Codec is excluded — SDP renegotiate isn't supported here;
  // codec applies on next start. ShareMode change additionally fires the
  // dedicated handler so the SFU swaps its adaptation policy.
  const firstRender = useRef(true);
  const lastShareMode = useRef(effective.shareMode);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      lastShareMode.current = effective.shareMode;
      return;
    }
    if (!publishing) {
      lastShareMode.current = effective.shareMode;
      return;
    }
    if (lastShareMode.current !== effective.shareMode && onShareModeChange) {
      void onShareModeChange(effective.shareMode);
      lastShareMode.current = effective.shareMode;
    }
    if (!onLiveUpdate) return;
    const t = window.setTimeout(() => {
      void onLiveUpdate();
    }, 250);
    return () => window.clearTimeout(t);
  }, [
    mode,
    effective.resolution,
    effective.fps,
    effective.shareMode,
    publishing,
    onLiveUpdate,
    onShareModeChange,
  ]);

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <span className="section-label">Пресет</span>
        <ModeRadio mode={mode} onChange={setMode} />
        <div className="grid grid-cols-3 gap-2">
          <Dropdown
            label="Качество"
            value={effective.resolution}
            disabled={mode !== 'custom'}
            onChange={(v) => setResolution(v as ScreenResolution)}
            options={SCREEN_RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_LABELS[r] }))}
          />
          <Dropdown
            label="FPS"
            value={String(effective.fps)}
            disabled={mode !== 'custom'}
            onChange={(v) => setFps(Number(v) as ScreenFps)}
            options={SCREEN_FPS_OPTIONS.map((f) => ({ value: String(f), label: fpsLabel(f) }))}
          />
          <Dropdown
            label="Приоритет"
            value={effective.shareMode}
            disabled={mode !== 'custom'}
            onChange={(v) => setShareMode(v as ShareMode)}
            options={SHARE_MODES.map((m) => ({ value: m, label: SHARE_MODE_LABELS[m] }))}
          />
        </div>
      </div>
      <Dropdown
        label="Кодек"
        value={effective.codec}
        disabled={publishing}
        onChange={(v) => setCodec(v as ScreenCodecPref)}
        options={SCREEN_CODEC_OPTIONS.map((c) => ({ value: c, label: CODEC_LABELS[c] }))}
      />
    </div>
  );
}

function ModeRadio({ mode, onChange }: { mode: ScreenMode; onChange: (m: ScreenMode) => void }) {
  const options: { id: ScreenMode; label: string }[] = [
    ...SCREEN_PRESETS.map((p) => ({ id: p.id as ScreenMode, label: p.label })),
    { id: 'custom', label: 'Вручную' },
  ];
  return (
    <div role="radiogroup" className="grid grid-cols-3 gap-1">
      {options.map((o) => {
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className={`px-2 py-1.5 text-xs uppercase tracking-[0.08em] border transition-colors
              ${
                active
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-line text-muted hover:border-muted-2'
              }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Dropdown({
  label,
  value,
  disabled,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="grid gap-1">
      <span className="section-label">{label}</span>
      <div className="relative">
        <select
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="appearance-none w-full pl-2 pr-7 py-1.5 text-[12px] uppercase tracking-[0.08em]
            bg-bg-input border border-line text-muted cursor-pointer
            hover:border-muted-2 focus:outline-none focus:border-accent transition-colors
            disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-2 pointer-events-none"
        />
      </div>
    </div>
  );
}
