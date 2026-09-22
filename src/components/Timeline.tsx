import { useEffect, useRef, useState } from "react";
import { clipLength, clipStart, fmtTime, timelineDuration, useStore } from "../lib/store";

const MIN_CLIP = 0.1;

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const selectedId = useStore((s) => s.selectedClipId);
  const { setPlayhead, setPlaying, selectClip, updateClip, removeClip, moveClip, splitAtPlayhead } =
    useStore.getState();

  const [pxPerSec, setPxPerSec] = useState(20);
  const trackRef = useRef<HTMLDivElement>(null);
  const total = timelineDuration(clips);

  // Fit-to-width on first load / when the total changes a lot.
  useEffect(() => {
    const w = trackRef.current?.clientWidth ?? 800;
    if (total > 0) setPxPerSec(Math.max(2, Math.min(200, (w - 20) / total)));
  }, [clips.length]);

  const timeAt = (clientX: number) => {
    const el = trackRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, (clientX - r.left + el.scrollLeft) / pxPerSec));
  };

  const onTrackPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".clip")) return;
    setPlaying(false);
    setPlayhead(timeAt(e.clientX));
    const move = (ev: PointerEvent) => setPlayhead(timeAt(ev.clientX));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startTrim = (e: React.PointerEvent, id: string, edge: "in" | "out") => {
    e.stopPropagation();
    e.preventDefault();
    setPlaying(false);
    selectClip(id);
    const clip = useStore.getState().clips.find((c) => c.id === id)!;
    const m = media[clip.mediaPath];
    const x0 = e.clientX;
    const orig = { ...clip };
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pxPerSec;
      if (edge === "in") {
        const inPoint = Math.max(0, Math.min(orig.outPoint - MIN_CLIP, orig.inPoint + dt));
        updateClip(id, { inPoint });
        setPlayhead(clipStart(useStore.getState().clips, id));
      } else {
        const outPoint = Math.min(m?.duration ?? Infinity, Math.max(orig.inPoint + MIN_CLIP, orig.outPoint + dt));
        updateClip(id, { outPoint });
        setPlayhead(clipStart(useStore.getState().clips, id) + (outPoint - orig.inPoint));
      }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks: number[] = [];
  const step = pxPerSec > 60 ? 1 : pxPerSec > 25 ? 5 : pxPerSec > 8 ? 10 : pxPerSec > 3 ? 30 : 60;
  for (let t = 0; t <= total; t += step) ticks.push(t);

  let x = 0;
  return (
    <div className="timeline">
      <div className="timeline-toolbar">
        <button onClick={() => setPlaying(!playing)} disabled={!clips.length} title="Space">
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={() => { setPlaying(false); setPlayhead(0); }} title="Home">⏮</button>
        <span className="time">{fmtTime(playhead)} / {fmtTime(total)}</span>
        <span className="spacer" />
        <button onClick={splitAtPlayhead} disabled={!clips.length} title="S">Split</button>
        <button onClick={() => selectedId && moveClip(selectedId, -1)} disabled={!selectedId} title="Move earlier">◀</button>
        <button onClick={() => selectedId && moveClip(selectedId, 1)} disabled={!selectedId} title="Move later">▶</button>
        <button onClick={() => selectedId && removeClip(selectedId)} disabled={!selectedId} title="Delete" className="danger">
          Remove
        </button>
        <span className="spacer" />
        <label className="zoom">
          Zoom
          <input type="range" min={1} max={200} value={pxPerSec} onChange={(e) => setPxPerSec(+e.target.value)} />
        </label>
      </div>
      <div className="track-scroll" ref={trackRef} onPointerDown={onTrackPointerDown}>
        <div className="track" style={{ width: Math.max(total * pxPerSec + 40, 100) }}>
          <div className="ruler">
            {ticks.map((t) => (
              <span key={t} className="tick" style={{ left: t * pxPerSec }}>{fmtTime(t).replace(/\.\d+$/, "")}</span>
            ))}
          </div>
          <div className="clips">
            {clips.map((c) => {
              const left = x;
              const w = clipLength(c) * pxPerSec;
              x += w;
              const m = media[c.mediaPath];
              const oriented = c.yaw || c.pitch || c.roll;
              return (
                <div
                  key={c.id}
                  className={"clip" + (c.id === selectedId ? " selected" : "")}
                  style={{ left, width: Math.max(w, 2) }}
                  onPointerDown={(e) => { e.stopPropagation(); selectClip(c.id); setPlaying(false); setPlayhead(left / pxPerSec + Math.min(clipLength(c), Math.max(0, (e.clientX - trackRef.current!.getBoundingClientRect().left + trackRef.current!.scrollLeft - left) / pxPerSec))); }}
                >
                  <div className="clip-handle left" onPointerDown={(e) => startTrim(e, c.id, "in")} />
                  <div className="clip-body">
                    <div className="clip-name">{m?.name ?? c.mediaPath}</div>
                    <div className="clip-meta">
                      {fmtTime(c.inPoint)} → {fmtTime(c.outPoint)} · {fmtTime(clipLength(c))}
                      {oriented ? ` · ↻ ${c.yaw}°/${c.pitch}°/${c.roll}°` : ""}
                    </div>
                  </div>
                  <div className="clip-handle right" onPointerDown={(e) => startTrim(e, c.id, "out")} />
                </div>
              );
            })}
          </div>
          <div className="playhead" style={{ left: playhead * pxPerSec }} />
        </div>
      </div>
    </div>
  );
}
