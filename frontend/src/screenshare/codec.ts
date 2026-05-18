// Codec preference helper for screen-share transceivers.
//
// AV1 only. Target browsers (Chrome / Edge / WebView2) all support AV1
// WebRTC encode. Everything else is filtered out — negotiation failing
// loudly is preferable to a silent fallback that hides a misconfigured
// client. The SFU also registers only AV1.

type Codec = RTCRtpCodec & { mimeType: string };

/**
 * Returns the input codec list filtered to AV1 only. If AV1 is absent,
 * returns an empty array — setCodecPreferences([]) then raises and the
 * caller surfaces the failure.
 */
export function orderCodecsAV1First<T extends Codec>(codecs: readonly T[]): T[] {
  return codecs.filter((codec) => codec.mimeType.split('/')[1]?.toUpperCase() === 'AV1');
}
