import { saveScreenCodecPreference } from '../utils/storage';
import { SCREEN_FPS } from './params';
import { screenCodecBucket, type ScreenVideoCodec } from './codec';

type OutboundVideoStats = {
  id: string;
  type: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  framesEncoded?: number;
  framesPerSecond?: number;
  qualityLimitationReason?: string;
  totalEncodeTime?: number;
};

type CodecStats = {
  id: string;
  type: string;
  mimeType?: string;
};

export type ScreenShareHealthMonitor = {
  stop(): void;
};

const POLL_MS = 1000;
const MAX_WALL_MS = 12_000;
const BAD_SAMPLE_THRESHOLD = 5;
const FPS_FLOOR = SCREEN_FPS * 0.7;
const ENCODE_BUDGET_SECONDS = (1 / SCREEN_FPS) * 0.8;
const PREFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

function asOutboundVideoStats(value: unknown): OutboundVideoStats | null {
  const stat = value as Partial<OutboundVideoStats>;
  if (
    stat.type === 'outbound-rtp' &&
    (stat.kind === 'video' || stat.mediaType === 'video') &&
    typeof stat.id === 'string'
  ) {
    return stat as OutboundVideoStats;
  }
  return null;
}

function codecFromStats(report: RTCStatsReport, outbound: OutboundVideoStats): ScreenVideoCodec | null {
  if (!outbound.codecId) return null;
  const codec = report.get(outbound.codecId) as CodecStats | undefined;
  const mime = codec?.mimeType?.split('/')[1]?.toUpperCase();
  if (mime === 'AV1') return 'av1';
  if (mime === 'VP9') return 'vp9';
  return null;
}

function rememberVP9(reason: string): void {
  saveScreenCodecPreference({
    codec: 'vp9',
    bucket: screenCodecBucket(),
    reason,
    expiresAt: Date.now() + PREFERENCE_TTL_MS,
  });
}

export function startScreenShareHealthMonitor(
  sender: RTCRtpSender,
  expectedCodec: ScreenVideoCodec,
): ScreenShareHealthMonitor {
  if (expectedCodec !== 'av1') return { stop: () => undefined };

  let stopped = false;
  let lastFrames: number | null = null;
  let lastEncodeTime: number | null = null;
  let badSamples = 0;
  let timer: number | null = null;
  const startedAt = Date.now();

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const poll = async () => {
    if (stopped) return;
    if (Date.now() - startedAt > MAX_WALL_MS) {
      stop();
      return;
    }

    try {
      const report = await sender.getStats();
      const outboundStats: OutboundVideoStats[] = [];
      report.forEach((value) => {
        const outbound = asOutboundVideoStats(value);
        if (outbound) outboundStats.push(outbound);
      });
      const outbound = outboundStats[0];
      if (!outbound) return;
      if (codecFromStats(report, outbound) !== 'av1') return;

      const frames = outbound.framesEncoded;
      const encodeTime = outbound.totalEncodeTime;
      if (typeof frames !== 'number' || typeof encodeTime !== 'number') return;
      if (lastFrames === null || lastEncodeTime === null) {
        lastFrames = frames;
        lastEncodeTime = encodeTime;
        return;
      }

      const frameDelta = frames - lastFrames;
      const encodeDelta = encodeTime - lastEncodeTime;
      lastFrames = frames;
      lastEncodeTime = encodeTime;
      if (frameDelta <= 0 || encodeDelta < 0) return;

      const averageEncodeTime = encodeDelta / frameDelta;
      const reason = outbound.qualityLimitationReason;
      const fps = outbound.framesPerSecond;
      const cpuLimited = reason === 'cpu';
      const fpsLimited =
        typeof fps === 'number' && fps > 0 && fps < FPS_FLOOR && reason !== 'bandwidth';
      const encodeLimited = averageEncodeTime > ENCODE_BUDGET_SECONDS;
      if (cpuLimited || fpsLimited || encodeLimited) {
        badSamples += 1;
      }
      if (badSamples >= BAD_SAMPLE_THRESHOLD) {
        rememberVP9(cpuLimited ? 'cpu' : fpsLimited ? 'fps' : 'encode-time');
        stop();
      }
    } finally {
      if (!stopped) {
        timer = window.setTimeout(poll, POLL_MS);
      }
    }
  };

  timer = window.setTimeout(poll, POLL_MS);
  return { stop };
}
