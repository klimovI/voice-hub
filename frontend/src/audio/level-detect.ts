export const SPEAKING_THRESHOLD = 0.02;

export function detectLevel(analyser: AnalyserNode, data: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length);
}
