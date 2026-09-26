import { useEffect, useRef } from "react";
import { envelope, usePeaks } from "../lib/waveform";

interface Props {
  path: string;
  /** Which slice of the file is on screen, in seconds. */
  inPoint: number;
  outPoint: number;
  duration: number;
  width: number;
  height: number;
  /** Drawn dimmer when the clip is not selected. */
  selected: boolean;
  /** Linear level, scaling the drawn height so a quiet clip looks quiet. */
  gain?: number;
}

/**
 * The waveform inside an audio track. Drawn on a canvas rather than as SVG
 * because a long track at high zoom is thousands of vertical strokes, and the
 * DOM is the wrong shape for that.
 */
export function Waveform({ path, inPoint, outPoint, duration, width, height, selected, gain = 1 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = usePeaks(path);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const mid = h / 2;
    if (!peaks || duration <= 0) {
      // No peaks yet: a centre line, so the track still reads as audio.
      g.strokeStyle = selected ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.25)";
      g.beginPath();
      g.moveTo(0, mid);
      g.lineTo(w, mid);
      g.stroke();
      return;
    }

    const env = envelope(peaks, inPoint / duration, outPoint / duration, w);
    const scale = Math.min(1, gain);
    g.fillStyle = selected ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.55)";
    for (let x = 0; x < env.length; x++) {
      // Always at least a hairline, so silence is still a visible baseline.
      const half = Math.max(0.5, env[x] * scale * (mid - 1));
      g.fillRect(x, mid - half, 1, half * 2);
    }
  }, [peaks, inPoint, outPoint, duration, width, height, selected, gain]);

  return <canvas ref={ref} className="waveform" style={{ width, height }} />;
}
