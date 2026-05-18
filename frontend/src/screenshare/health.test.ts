import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { startScreenShareHealthMonitor } from './health';
import { loadScreenCodecPreference } from '../utils/storage';
import { screenCodecBucket } from './codec';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
}

function stats(framesEncoded: number, reason: string, totalEncodeTime: number): RTCStatsReport {
  return new Map<string, unknown>([
    [
      'out',
      {
        id: 'out',
        type: 'outbound-rtp',
        kind: 'video',
        codecId: 'codec',
        framesEncoded,
        framesPerSecond: 60,
        qualityLimitationReason: reason,
        totalEncodeTime,
      },
    ],
    ['codec', { id: 'codec', type: 'codec', mimeType: 'video/AV1' }],
  ]) as RTCStatsReport;
}

describe('screen share health monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('persists VP9 preference after sustained CPU-limited AV1 samples', async () => {
    let frames = 0;
    const sender = {
      getStats: vi.fn(async () => {
        frames += 10;
        return stats(frames, 'cpu', frames * 0.005);
      }),
    } as unknown as RTCRtpSender;

    startScreenShareHealthMonitor(sender, 'av1');
    await vi.advanceTimersByTimeAsync(7000);

    expect(loadScreenCodecPreference(screenCodecBucket())?.codec).toBe('vp9');
  });

  it('ignores paused periods where no frames are encoded', async () => {
    const sender = {
      getStats: vi.fn(async () => stats(0, 'cpu', 0)),
    } as unknown as RTCRtpSender;

    startScreenShareHealthMonitor(sender, 'av1');
    await vi.advanceTimersByTimeAsync(7000);

    expect(loadScreenCodecPreference(screenCodecBucket())).toBeNull();
  });

  it('does not persist VP9 on bandwidth-limited AV1 samples', async () => {
    let frames = 0;
    const sender = {
      getStats: vi.fn(async () => {
        frames += 10;
        return stats(frames, 'bandwidth', frames * 0.001);
      }),
    } as unknown as RTCRtpSender;

    startScreenShareHealthMonitor(sender, 'av1');
    await vi.advanceTimersByTimeAsync(7000);

    expect(loadScreenCodecPreference(screenCodecBucket())).toBeNull();
  });
});
