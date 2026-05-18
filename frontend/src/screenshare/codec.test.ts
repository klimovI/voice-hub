import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyScreenCodecPreferences,
  chooseScreenCodec,
  orderScreenCodecs,
  screenCodecBucket,
  type ScreenCodecSupport,
} from './codec';
import { saveScreenCodecPreference } from '../utils/storage';

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

function support(send: ('av1' | 'vp9')[]): ScreenCodecSupport {
  return {
    send: new Set(send),
    receive: new Set(send),
    av1HardwareLikely: null,
    vp9HardwareLikely: null,
  };
}

const codecs = [
  { mimeType: 'video/VP8', clockRate: 90000 },
  { mimeType: 'video/VP9', clockRate: 90000 },
  { mimeType: 'video/AV1', clockRate: 90000 },
] as RTCRtpCodec[];

describe('screen codec policy', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('prefers AV1 when both screen codecs are available', () => {
    expect(chooseScreenCodec(support(['av1', 'vp9']))).toBe('av1');
  });

  it('falls back to VP9 when AV1 send support is absent', () => {
    expect(chooseScreenCodec(support(['vp9']))).toBe('vp9');
  });

  it('honors a fresh persisted VP9 preference for the current capture bucket', () => {
    saveScreenCodecPreference({
      codec: 'vp9',
      bucket: screenCodecBucket(),
      reason: 'cpu',
      expiresAt: Date.now() + 1000,
    });
    expect(chooseScreenCodec(support(['av1', 'vp9']))).toBe('vp9');
  });

  it('orders AV1 before VP9 while retaining VP9 as negotiation fallback', () => {
    expect(orderScreenCodecs(codecs, 'av1').map((c) => c.mimeType)).toEqual([
      'video/AV1',
      'video/VP9',
      'video/VP8',
    ]);
  });

  it('forces VP9-only codec preferences when VP9 was selected', () => {
    const tx = { setCodecPreferences: vi.fn() } as unknown as RTCRtpTransceiver;
    applyScreenCodecPreferences(tx, { codecs, headerExtensions: [] }, 'vp9');
    expect(tx.setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: 'video/VP9', clockRate: 90000 },
    ]);
  });
});
