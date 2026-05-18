type Codec = RTCRtpCodec & { mimeType: string };

// AV1 only — server's MediaEngine registers only AV1. Loud negotiation
// failure preferable to silent fallback that hides a misconfigured client.
export function filterAV1<T extends Codec>(codecs: readonly T[]): T[] {
  return codecs.filter((codec) => codec.mimeType.split('/')[1]?.toUpperCase() === 'AV1');
}
