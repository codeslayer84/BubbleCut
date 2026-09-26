/**
 * Waveform peaks, fetched once per file and kept for the session.
 *
 * ffmpeg has to decode the whole file to answer, which is far too slow to do
 * on every repaint, so peaks are pulled at a fixed high resolution and
 * downsampled to whatever width the lane happens to be.
 */
import { useEffect, useState } from "react";
import { audioPeaks, isTauri } from "./tauri";

/** Enough detail for a wide lane; a few kB per file. */
const BUCKETS = 1500;

const cache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[]>>();
const failed = new Set<string>();

export function loadPeaks(path: string): Promise<number[]> {
  const have = cache.get(path);
  if (have) return Promise.resolve(have);
  let p = inflight.get(path);
  if (!p) {
    p = audioPeaks(path, BUCKETS)
      .then((v) => {
        cache.set(path, v);
        inflight.delete(path);
        return v;
      })
      .catch((e) => {
        inflight.delete(path);
        failed.add(path);
        throw e;
      });
    inflight.set(path, p);
  }
  return p;
}

/** null while loading, or if the peaks could not be read. */
export function usePeaks(path: string): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() => cache.get(path) ?? null);
  useEffect(() => {
    if (!isTauri || failed.has(path)) return;
    const have = cache.get(path);
    if (have) {
      setPeaks(have);
      return;
    }
    let live = true;
    loadPeaks(path)
      .then((v) => live && setPeaks(v))
      .catch(() => live && setPeaks(null));
    return () => {
      live = false;
    };
  }, [path]);
  return peaks;
}

/**
 * Reduce `peaks` to one value per pixel across the slice of the file between
 * `from` and `to` (both 0..1). Peak rather than average, so a short transient
 * still shows at low zoom.
 */
export function envelope(peaks: number[], from: number, to: number, width: number): number[] {
  const out = new Array<number>(Math.max(1, width)).fill(0);
  const lo = Math.max(0, Math.floor(from * peaks.length));
  const hi = Math.min(peaks.length, Math.ceil(to * peaks.length));
  const span = Math.max(1, hi - lo);
  for (let x = 0; x < out.length; x++) {
    const a = lo + Math.floor((x * span) / out.length);
    const b = Math.max(a + 1, lo + Math.floor(((x + 1) * span) / out.length));
    let m = 0;
    for (let i = a; i < b && i < peaks.length; i++) m = Math.max(m, peaks[i]);
    out[x] = m;
  }
  return out;
}
