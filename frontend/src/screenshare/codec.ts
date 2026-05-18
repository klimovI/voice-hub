// Codec preference helper for screen-share transceivers.
//
// AV1 first, VP9 fallback. Everything else (H.264, VP8) is filtered out:
// they are poor matches for screen content (text rendering smudges on
// inter-frame, no SVC support in browsers). The SFU registers only AV1
// and VP9 anyway — listing them here is defence-in-depth so a future
// browser that adds AV2 / etc. doesn't accidentally win negotiation.

type Codec = RTCRtpCodec & { mimeType: string };

/**
 * Returns the input codec list sorted by screen-share preference. AV1 is
 * preferred over VP9; codecs that aren't AV1 or VP9 are dropped entirely.
 *
 * Caller is expected to feed the result directly into
 * RTCRtpTransceiver.setCodecPreferences().
 */
export function orderCodecsAV1First<T extends Codec>(codecs: readonly T[]): T[] {
  const rank = (codec: T): number => {
    const name = codec.mimeType.split('/')[1]?.toUpperCase() ?? '';
    if (name === 'AV1') return 0;
    if (name === 'VP9') return 1;
    return 99;
  };
  return codecs.filter((codec) => rank(codec) < 99).sort((a, b) => rank(a) - rank(b));
}
