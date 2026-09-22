import { cardOpacity } from "../lib/cardRender";
import { cardAnglesFromView } from "../lib/orientation";
import { defaultCard, fmtTime, timelineDuration, useStore } from "../lib/store";
import type { TextCard } from "../lib/types";

const PRESET_POSITIONS: [string, number, number][] = [
  ["Front", 0, 0],
  ["Above front", 0, 25],
  ["Below front", 0, -25],
  ["Left", -60, 0],
  ["Right", 60, 0],
  ["Behind", 180, 0],
];

export function CardPanel() {
  const cards = useStore((s) => s.cards);
  const selectedId = useStore((s) => s.selectedCardId);
  const playhead = useStore((s) => s.playhead);
  const clips = useStore((s) => s.clips);
  const view = useStore((s) => s.view);
  const { addCard, updateCard, removeCard, selectCard, setPlayhead, setView } = useStore.getState();

  const total = timelineDuration(clips);
  const card = cards.find((c) => c.id === selectedId) ?? null;
  const set = (p: Partial<TextCard>) => card && updateCard(card.id, p);

  const add = () => {
    const { yaw, pitch } = cardAnglesFromView(view);
    // Span the whole video by default; trim it afterwards if you want.
    const card = defaultCard(0, Math.max(total, 1), yaw, pitch);
    addCard(card);
    // A card created while the playhead sits inside its fade would be drawn
    // fully transparent, which looks like nothing happened. Step just past
    // the fade so the new card is actually visible.
    if (cardOpacity(card, playhead) < 1) {
      setPlayhead(Math.min(card.end, card.start + card.fadeIn));
    }
  };

  return (
    <div className="cards">
      <h3>Text cards</h3>
      <p className="hint">
        Cards are placed in the 360° sphere and burned into the export, projected so they look flat
        in a headset instead of smeared across the equirectangular frame.
      </p>
      <div className="row">
        <button className="primary" onClick={add} disabled={!clips.length}>+ Add card at current view</button>
      </div>

      {cards.length > 0 && (
        <ul className="card-list">
          {cards.map((c) => (
            <li
              key={c.id}
              className={c.id === selectedId ? "sel" : ""}
              onClick={() => { selectCard(c.id); setPlayhead(c.start); }}
            >
              <div className="card-text">{c.text.split("\n")[0] || "(empty)"}</div>
              <div className="card-meta">{fmtTime(c.start)}–{fmtTime(c.end)} · {c.yaw}°/{c.pitch}°</div>
              <button className="danger" onClick={(e) => { e.stopPropagation(); removeCard(c.id); }}>×</button>
            </li>
          ))}
        </ul>
      )}

      {!card && cards.length > 0 && <p className="hint">Select a card above to edit it.</p>}

      {card && cardOpacity(card, playhead) < 1 && (
        <p className="hint">
          {playhead < card.start || playhead > card.end ? (
            <>
              Not on screen at the playhead.{" "}
              <button className="chip" onClick={() => setPlayhead(Math.min(card.end, card.start + card.fadeIn))}>
                Jump to it
              </button>
            </>
          ) : (
            <>
              Shown solid while selected so you can edit it; here it is really{" "}
              {Math.round(cardOpacity(card, playhead) * 100)}% opaque (mid-fade). Press play to see the
              real fade.
            </>
          )}
        </p>
      )}

      {card && (
        <>
          <h3>Text</h3>
          <textarea
            rows={3}
            value={card.text}
            onChange={(e) => set({ text: e.target.value })}
            placeholder="Type the caption…"
          />

          <h3>When</h3>
          <div className="grid2">
            <label className="field">
              <span>Start (s)</span>
              <input type="number" step={0.1} min={0} value={round(card.start)}
                onChange={(e) => set({ start: Math.min(+e.target.value, card.end - 0.1) })} />
            </label>
            <label className="field">
              <span>End (s)</span>
              <input type="number" step={0.1} min={0} value={round(card.end)}
                onChange={(e) => set({ end: Math.max(+e.target.value, card.start + 0.1) })} />
            </label>
          </div>
          <div className="row">
            <button onClick={() => set({ start: Math.min(playhead, card.end - 0.1) })}>Start here</button>
            <button onClick={() => set({ end: Math.max(playhead, card.start + 0.1) })}>End here</button>
            <button onClick={() => set({ start: 0, end: total })}>Whole video</button>
          </div>

          <div className="grid2">
            <label className="field">
              <span>Fade in (s)</span>
              <input type="number" step={0.1} min={0} max={10} value={round(card.fadeIn)}
                onChange={(e) => set({ fadeIn: Math.max(0, +e.target.value) })} />
            </label>
            <label className="field">
              <span>Fade out (s)</span>
              <input type="number" step={0.1} min={0} max={10} value={round(card.fadeOut)}
                onChange={(e) => set({ fadeOut: Math.max(0, +e.target.value) })} />
            </label>
          </div>
          {card.fadeIn + card.fadeOut > card.end - card.start && (
            <p className="hint">Fades are longer than the card — it never reaches full opacity.</p>
          )}

          <h3>Where</h3>
          <div className="row">
            <button className="primary" onClick={() => { set(cardAnglesFromView(view)); }}>
              ⌖ Move to current view
            </button>
            <button onClick={() => setView({ lon: card.yaw, lat: card.pitch })}>Look at card</button>
          </div>
          <div className="row">
            {PRESET_POSITIONS.map(([n, y, p]) => (
              <button key={n} className="chip" onClick={() => set({ yaw: y, pitch: p })}>{n}</button>
            ))}
          </div>
          <Slider label="Yaw" value={card.yaw} min={-180} max={180} onChange={(yaw) => set({ yaw })} />
          <Slider label="Pitch" value={card.pitch} min={-90} max={90} onChange={(pitch) => set({ pitch })} />
          <Slider label="Roll" value={card.roll} min={-180} max={180} onChange={(roll) => set({ roll })} />
          <Slider label="Size" value={card.widthDeg} min={5} max={120} step={1} unit="°"
            onChange={(widthDeg) => set({ widthDeg })} />

          <h3>Look</h3>
          <Slider label="Font" value={card.fontSize} min={24} max={320} step={2} unit="px"
            onChange={(fontSize) => set({ fontSize })} />
          <div className="grid2">
            <label className="field">
              <span>Text colour</span>
              <input type="color" value={card.color} onChange={(e) => set({ color: e.target.value })} />
            </label>
            <label className="field">
              <span>Box colour</span>
              <input type="color" value={card.bgColor} onChange={(e) => set({ bgColor: e.target.value })} />
            </label>
          </div>
          <Slider label="Box" value={card.bgOpacity} min={0} max={1} step={0.05}
            onChange={(bgOpacity) => set({ bgOpacity })} />
          <Slider label="Corner" value={card.radius} min={0} max={120} step={2} unit="px"
            onChange={(radius) => set({ radius })} />
          <Slider label="Padding" value={card.padding} min={0} max={200} step={4} unit="px"
            onChange={(padding) => set({ padding })} />
          <div className="row">
            <label><input type="checkbox" checked={card.bold} onChange={(e) => set({ bold: e.target.checked })} /> Bold</label>
            <label><input type="checkbox" checked={card.shadow} onChange={(e) => set({ shadow: e.target.checked })} /> Shadow</label>
            <select value={card.align} onChange={(e) => set({ align: e.target.value as TextCard["align"] })}>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}

const round = (n: number) => Math.round(n * 10) / 10;

function Slider({ label, value, min, max, step = 0.5, unit = "", onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="angle">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <input type="number" min={min} max={max} step={step} value={round(value)} onChange={(e) => onChange(+e.target.value || 0)} />
      <span className="unit">{unit}</span>
    </label>
  );
}
