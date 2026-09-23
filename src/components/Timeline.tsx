import { useEffect, useRef, useState } from "react";
import { cardOpacity } from "../lib/cardRender";
import { clipLength, clipStart, fmtTime, timelineDuration, useStore } from "../lib/store";

const MIN_CLIP = 0.1;

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const selectedId = useStore((s) => s.selectedClipId);
  const cards = useStore((s) => s.cards);
  const selectedCardId = useStore((s) => s.selectedCardId);
  const {
    setPlayhead, setPlaying, selectClip, updateClip, removeClip, moveClip, splitAtPlayhead,
    selectCard, updateCard, setRightTab,
  } = useStore.getState();

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

  // Dragging a card along the timeline, or taking hold of one of its ends.
  const startCardDrag = (e: React.PointerEvent, id: string, mode: "move" | "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    setPlaying(false);
    selectCard(id);
    const card = useStore.getState().cards.find((c) => c.id === id)!;
    const x0 = e.clientX;
    const orig = { start: card.start, end: card.end };
    const span = orig.end - orig.start;

    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pxPerSec;
      if (mode === "move") {
        const start = Math.max(0, Math.min(total - span, orig.start + dt));
        updateCard(id, { start, end: start + span });
      } else if (mode === "start") {
        updateCard(id, { start: Math.max(0, Math.min(orig.end - MIN_CLIP, orig.start + dt)) });
      } else {
        updateCard(id, { end: Math.max(orig.start + MIN_CLIP, Math.min(total, orig.end + dt)) });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Selecting a card whose fade hides it at the playhead is confusing, so
  // step to where it is fully on screen.
  const revealCard = (id: string) => {
    const card = useStore.getState().cards.find((c) => c.id === id);
    if (!card) return;
    if (cardOpacity(card, useStore.getState().playhead) < 1) {
      setPlayhead(Math.min(card.end, card.start + card.fadeIn));
    }
  };

  // Cards that overlap in time go on separate rows, so each one stays
  // readable and can be grabbed without fighting its neighbour for the click.
  const CARD_ROW_H = 26;
  const CARD_ROW_GAP = 4;
  const cardRows = (() => {
    const rowEnds: number[] = [];
    const placed = new Map<string, number>();
    for (const c of [...cards].sort((a, b) => a.start - b.start)) {
      let row = rowEnds.findIndex((end) => c.start >= end - 1e-6);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(0);
      }
      rowEnds[row] = c.end;
      placed.set(c.id, row);
    }
    return { placed, count: Math.max(rowEnds.length, 1) };
  })();
  const laneHeight = cardRows.count * CARD_ROW_H + (cardRows.count - 1) * CARD_ROW_GAP;

  const ticks: number[] = [];
  const step = pxPerSec > 60 ? 1 : pxPerSec > 25 ? 5 : pxPerSec > 8 ? 10 : pxPerSec > 3 ? 30 : 60;
  for (let t = 0; t <= total; t += step) ticks.push(t);

  let x = 0;
  // The lane grows with the number of rows, taking the space from the viewer.
  const timelineHeight = 152 + (cards.length ? laneHeight + 8 : 0);

  return (
    <div className="timeline" style={{ height: timelineHeight }}>
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
                    {c.filters.length > 0 && (
                      <div
                        className="clip-filters"
                        title={`Filters: ${c.filters.map((f) => f.name).join(" → ")}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          selectClip(c.id);
                          setRightTab("filters");
                        }}
                      >
                        {/* Names need room; a narrow clip just gets the count. */}
                        {w >= 120
                          ? c.filters.map((f) => (
                              <span className="clip-filter" key={f.id}>{f.name}</span>
                            ))
                          : <span className="clip-filter">{c.filters.length} filter{c.filters.length === 1 ? "" : "s"}</span>}
                      </div>
                    )}
                  </div>
                  <div className="clip-handle right" onPointerDown={(e) => startTrim(e, c.id, "out")} />
                </div>
              );
            })}
          </div>
          {cards.length > 0 && (
            <div className="card-lane" style={{ height: laneHeight }}>
              {cards.map((c) => {
                const left = c.start * pxPerSec;
                const w = Math.max((c.end - c.start) * pxPerSec, 3);
                const row = cardRows.placed.get(c.id) ?? 0;
                return (
                  <div
                    key={c.id}
                    className={"tl-card" + (c.id === selectedCardId ? " selected" : "")}
                    style={{ left, width: w, top: row * (CARD_ROW_H + CARD_ROW_GAP), height: CARD_ROW_H }}
                    title={c.text}
                    onPointerDown={(e) => { startCardDrag(e, c.id, "move"); revealCard(c.id); }}
                  >
                    <div
                      className="tl-card-handle"
                      onPointerDown={(e) => startCardDrag(e, c.id, "start")}
                    />
                    <div className="tl-card-label">{c.text.split("\n")[0] || "(empty)"}</div>
                    <div
                      className="tl-card-handle"
                      onPointerDown={(e) => startCardDrag(e, c.id, "end")}
                    />
                    {c.fadeIn > 0 && (
                      <div className="tl-card-fade in" style={{ width: Math.min(c.fadeIn * pxPerSec, w / 2) }} />
                    )}
                    {c.fadeOut > 0 && (
                      <div className="tl-card-fade out" style={{ width: Math.min(c.fadeOut * pxPerSec, w / 2) }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="playhead" style={{ left: playhead * pxPerSec }} />
        </div>
      </div>
    </div>
  );
}
