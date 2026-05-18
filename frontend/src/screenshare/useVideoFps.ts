import { useEffect, useState } from 'react';

export function useVideoFps(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  stream: MediaStream | null,
) {
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !('requestVideoFrameCallback' in el)) return;
    let stopped = false;
    let handle = 0;
    let lastTime: number | null = null;
    let frames = 0;
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (stopped) return;
      if (lastTime === null) {
        lastTime = metadata.mediaTime;
      } else {
        frames += 1;
        const elapsed = metadata.mediaTime - lastTime;
        if (elapsed >= 1) {
          setFps(frames / elapsed);
          frames = 0;
          lastTime = metadata.mediaTime;
        }
      }
      handle = el.requestVideoFrameCallback(onFrame);
    };
    handle = el.requestVideoFrameCallback(onFrame);
    return () => {
      stopped = true;
      el.cancelVideoFrameCallback(handle);
      setFps(null);
    };
  }, [videoRef, stream]);

  return fps;
}
