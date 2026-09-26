import { Splitter } from "./Splitter";
import { Waveform } from "./Waveform";
import { PANEL_LIMITS } from "../lib/layout";
import { useEffect, useRef, useState } from "react";
import { cardOpacity } from "../lib/cardRender";
import { normalizeRanges, selectionDuration } from "../lib/selection";
import { clipLength, clipStart, fmtTime, timelineDuration, useStore } from "../lib/store";

const MIN_CLIP = 0.1;

export function Timeline() {
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const selectedId = useStore((s) => s.selectedClipId);
  const selectedIds = useStore((s) => s.selectedClipIds);
  const cards = useStore((s) => s.cards);
  const selectedCardId = useStore((s) => s.selectedCardId);
  const selections = useStore((s) => s.selections);
  const {
    setPlayhead, setPlaying, selectClip, updateClip, removeClip, moveClip, splitAtPlayhead,
    selectCard, updateCard, setRightTab,
    addSelection, updateSelection, removeSelection, clearSelections, setPanel, resetPanel,
    selectAudio, updateAudio,
    toggleClipSelected, selectClipRange,
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

    // The handles sit at the clip edges, which is exactly where someone aims
    // when picking a clip out. With a modifier held, select rather than trim.
    if (e.metaKey || e.ctrlKey) {
      toggleClipSelected(id);
      return;
    }
    if (e.shiftKey) {
      selectClipRange(id);
      return;
    }

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
  const startAudioDrag = (e: React.PointerEvent, id: string, mode: "move" | "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    setPlaying(false);
    selectAudio(id);
    const t = useStore.getState().audio.find((a) => a.id === id)!;
    const x0 = e.clientX;
    const orig = { start: t.start, inPoint: t.inPoint, outPoint: t.outPoint };
    const fileLen = media[t.mediaPath]?.duration ?? orig.outPoint;

    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / pxPerSec;
      if (mode === "move") {
        updateAudio(id, { start: Math.max(0, orig.start + dt) });
      } else if (mode === "start") {
        // Trimming the head eats into the file and moves the track along by
        // the same amount, so the sound under the cursor stays where it is.
        // Leftwards is limited by how much file lies before the in point and
        // by the start of the timeline; rightwards by leaving something left.
        const lo = -Math.min(orig.inPoint, orig.start);
        const hi = orig.outPoint - orig.inPoint - MIN_CLIP;
        const d = Math.max(lo, Math.min(hi, dt));
        updateAudio(id, { start: orig.start + d, inPoint: orig.inPoint + d });
      } else {
        const d = Math.max(orig.inPoint + MIN_CLIP - orig.outPoint, Math.min(fileLen - orig.outPoint, dt));
        updateAudio(id, { outPoint: orig.outPoint + d });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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

  // Each drag along the ruler adds another range, so several parts of a
  // recording can be marked in one pass.
  const startSelectionDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setPlaying(false);
    const anchor = timeAt(e.clientX);
    let id: string | null = null;
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      const range = { start: Math.min(anchor, t), end: Math.max(anchor, t) };
      if (id) updateSelection(id, range);
      else id = addSelection(range);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragSelectionEdge = (e: React.PointerEvent, id: string, edge: "start" | "end") => {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const t = timeAt(ev.clientX);
      const r = useStore.getState().selections.find((x) => x.id === id);
      if (!r) return;
      updateSelection(id, edge === "start" ? { start: t, end: r.end } : { start: r.start, end: t });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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

  const audio = useStore((s) => s.audio);
  const selectedAudioId = useStore((s) => s.selectedAudioId);
  const AUDIO_ROW_H = 40;
  // Tracks that overlap share the lane on separate rows, same as cards.
  const audioRows = (() => {
    const placed = new Map<string, number>();
    const rowEnds: number[] = [];
    for (const t of [...audio].sort((a, b) => a.start - b.start)) {
      const end = t.start + (t.outPoint - t.inPoint);
      let row = rowEnds.findIndex((e) => t.start >= e - 1e-6);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(0);
      }
      rowEnds[row] = end;
      placed.set(t.id, row);
    }
    return { placed, count: Math.max(rowEnds.length, 1) };
  })();
  const audioLaneH = audio.length ? audioRows.count * AUDIO_ROW_H + (audioRows.count - 1) * 3 : 0;
  // Music can run past the last clip. The ruler still measures the video, but
  // the scrollable area has to reach the end of the sound or its tail cannot
  // be grabbed.
  const contentEnd = audio.reduce((m, t) => Math.max(m, t.start + (t.outPoint - t.inPoint)), total);

  // The stretches that will not be exported, for dimming.
  const merged = normalizeRanges(selections);
  const dimGaps: { from: number; to: number }[] = [];
  if (merged.length) {
    let at = 0;
    for (const r of merged) {
      if (r.start > at) dimGaps.push({ from: at, to: r.start });
      at = Math.max(at, r.end);
    }
    if (at < total) dimGaps.push({ from: at, to: total });
  }

  const ticks: number[] = [];
  const step = pxPerSec > 60 ? 1 : pxPerSec > 25 ? 5 : pxPerSec > 8 ? 10 : pxPerSec > 3 ? 30 : 60;
  for (let t = 0; t <= total; t += step) ticks.push(t);

  let x = 0;
  // The lane grows with the number of rows, taking the space from the viewer.
  // Sized to its contents until someone drags it, then their height wins.
  const autoHeight = 152 + (cards.length ? laneHeight + 8 : 0) + (audio.length ? audioLaneH + 8 : 0);
  const userHeight = useStore((s) => s.panels.timeline);
  const timelineHeight = userHeight ?? autoHeight;

  return (
    <div className="timeline" style={{ height: timelineHeight }}>
      <Splitter
        axis="row" label="Timeline height" invert
        value={timelineHeight}
        min={PANEL_LIMITS.timeline.min} max={PANEL_LIMITS.timeline.max}
        onChange={(px) => setPanel("timeline", px)}
        onReset={() => resetPanel("timeline")}
      />
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
        <button
          onClick={() => {
            const all = useStore.getState().clips;
            const everything = selectedIds.length === all.length;
            useStore.setState({
              selectedClipIds: everything ? [] : all.map((c) => c.id),
              selectedClipId: everything ? null : all[all.length - 1]?.id ?? null,
            });
          }}
          disabled={clips.length < 2}
          title="Select every clip"
        >
          {selectedIds.length === clips.length && clips.length > 1 ? "Deselect all" : "Select all"}
        </button>
        {selectedIds.length > 1 && (
          <span className="hint sel-readout">{selectedIds.length} clips selected</span>
        )}
        <span className="sep" />
        <button
          onClick={() => addSelection({ start: playhead, end: Math.min(total, playhead + 5) })}
          disabled={!clips.length}
          title="Add a five second range here, then drag its edges"
        >
          + Range
        </button>
        {selections.length > 0 && (
          <>
            <span className="hint sel-readout">
              {selections.length} range{selections.length === 1 ? "" : "s"} ·{" "}
              {fmtTime(selectionDuration(clips, selections))}
            </span>
            <button onClick={clearSelections} title="Remove every range">Clear</button>
          </>
        )}
        <span className="spacer" />
        <label className="zoom">
          Zoom
          <input type="range" min={1} max={200} value={pxPerSec} onChange={(e) => setPxPerSec(+e.target.value)} />
        </label>
      </div>
      <div className="track-scroll" ref={trackRef} onPointerDown={onTrackPointerDown}>
        <div className="track" style={{ width: Math.max(contentEnd * pxPerSec + 40, 100) }}>
          <div className="ruler" onPointerDown={startSelectionDrag} title="Drag to choose what to export">
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
              const titleText = c.fill
                ? (cards.find((k) => Math.abs(k.start - left / pxPerSec) < 0.2)?.text ?? "").split("\n")[0]
                : "";
              return (
                <div
                  key={c.id}
                  className={
                    "clip" +
                    (c.fill ? " fill" : "") +
                    (c.id === selectedId ? " selected" : "") +
                    (selectedIds.includes(c.id) ? " multi" : "")
                  }
                  style={{ left, width: Math.max(w, 2) }}
                  title="Cmd-click to add to the selection, Shift-click for a range"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setPlaying(false);
                    // Cmd/Ctrl adds or removes, Shift extends, a plain click
                    // selects just this one and moves the playhead.
                    if (e.metaKey || e.ctrlKey) {
                      toggleClipSelected(c.id);
                      return;
                    }
                    if (e.shiftKey) {
                      selectClipRange(c.id);
                      return;
                    }
                    selectClip(c.id);
                    const rect = trackRef.current!.getBoundingClientRect();
                    const within = (e.clientX - rect.left + trackRef.current!.scrollLeft - left) / pxPerSec;
                    setPlayhead(left / pxPerSec + Math.min(clipLength(c), Math.max(0, within)));
                  }}
                >
                  <div className="clip-handle left" onPointerDown={(e) => startTrim(e, c.id, "in")} />
                  <div className="clip-body">
                    <div className="clip-name">
                      {c.fill ? (titleText ? `Title — ${titleText}` : "Title card") : (m?.name ?? c.mediaPath)}
                    </div>
                    <div className="clip-meta">
                      {c.fill
                        ? `${fmtTime(clipLength(c))} · ${c.fill.color}`
                        : `${fmtTime(c.inPoint)} → ${fmtTime(c.outPoint)} · ${fmtTime(clipLength(c))}` +
                          (oriented ? ` · ↻ ${c.yaw}°/${c.pitch}°/${c.roll}°` : "")}
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
          {audio.length > 0 && (
            <div className="audio-lane" style={{ height: audioLaneH }}>
              {audio.map((t) => {
                const len = t.outPoint - t.inPoint;
                const left = t.start * pxPerSec;
                const w = Math.max(len * pxPerSec, 4);
                const row = audioRows.placed.get(t.id) ?? 0;
                const m = media[t.mediaPath];
                const sel = t.id === selectedAudioId;
                return (
                  <div
                    key={t.id}
                    className={"tl-audio" + (sel ? " selected" : "")}
                    style={{ left, width: w, top: row * (AUDIO_ROW_H + 3), height: AUDIO_ROW_H }}
                    title={`${m?.name ?? t.mediaPath} — ${fmtTime(len)}`}
                    onPointerDown={(e) => startAudioDrag(e, t.id, "move")}
                  >
                    <Waveform
                      path={t.mediaPath}
                      inPoint={t.inPoint}
                      outPoint={t.outPoint}
                      duration={m?.duration ?? t.outPoint}
                      width={w}
                      height={AUDIO_ROW_H}
                      selected={sel}
                    />
                    <div className="tl-audio-label">{m?.name ?? t.mediaPath}</div>
                    <div className="tl-audio-handle left" onPointerDown={(e) => startAudioDrag(e, t.id, "start")} />
                    <div className="tl-audio-handle right" onPointerDown={(e) => startAudioDrag(e, t.id, "end")} />
                    {t.fadeIn > 0 && (
                      <div className="tl-audio-fade in" style={{ width: Math.min(t.fadeIn * pxPerSec, w / 2) }} />
                    )}
                    {t.fadeOut > 0 && (
                      <div className="tl-audio-fade out" style={{ width: Math.min(t.fadeOut * pxPerSec, w / 2) }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {selections.length > 0 && (
            <div className="selection-layer">
              {/* Everything not inside a range is dimmed, so what will be
                  exported is obvious at a glance. */}
              {dimGaps.map((g, i) => (
                <div
                  key={`gap${i}`}
                  className="sel-dim"
                  style={{ left: g.from * pxPerSec, width: Math.max(0, (g.to - g.from) * pxPerSec) }}
                />
              ))}
              {selections.map((r, i) => (
                <div
                  key={r.id}
                  className="sel-band"
                  style={{
                    left: r.start * pxPerSec,
                    width: Math.max(3, (r.end - r.start) * pxPerSec),
                  }}
                  title={`${fmtTime(r.start)}–${fmtTime(r.end)}`}
                >
                  <div className="sel-handle left" onPointerDown={(e) => dragSelectionEdge(e, r.id, "start")} />
                  <span className="sel-index">{i + 1}</span>
                  <button
                    className="sel-remove"
                    title="Remove this range"
                    onPointerDown={(e) => { e.stopPropagation(); removeSelection(r.id); }}
                  >
                    ×
                  </button>
                  <div className="sel-handle right" onPointerDown={(e) => dragSelectionEdge(e, r.id, "end")} />
                </div>
              ))}
            </div>
          )}
          <div className="playhead" style={{ left: playhead * pxPerSec }} />
        </div>
      </div>
    </div>
  );
}
