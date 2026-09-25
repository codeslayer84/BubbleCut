import { clipAt, fmtBytes, fmtTime, useStore } from "../lib/store";
import { frontFromView } from "../lib/orientation";

function Angle({ label, value, onChange, min = -180, max = 180 }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number;
}) {
  return (
    <label className="angle">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={0.5} value={value} onChange={(e) => onChange(+e.target.value)} />
      <input type="number" min={min} max={max} step={0.5} value={value} onChange={(e) => onChange(+e.target.value || 0)} />
      <span className="unit">°</span>
    </label>
  );
}

export function Inspector() {
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const selectedId = useStore((s) => s.selectedClipId);
  const playhead = useStore((s) => s.playhead);
  const view = useStore((s) => s.view);
  const { updateClip, setView, setPlayhead } = useStore.getState();

  const clip = clips.find((c) => c.id === selectedId) ?? clipAt(clips, playhead)?.clip ?? null;
  if (!clip) return <div className="inspector empty">Select a clip to edit its orientation and trim.</div>;
  const m = media[clip.mediaPath];
  const set = (p: Partial<typeof clip>) => updateClip(clip.id, p);

  const setAsFront = () => {
    set(frontFromView(clip, view));
    setView({ lon: 0, lat: 0 });
  };
  const setIn = () => {
    const at = clipAt(clips, playhead);
    if (!at || at.clip.id !== clip.id) return;
    const inPoint = Math.min(at.sourceTime, clip.outPoint - 0.1);
    set({ inPoint });
    setPlayhead(at.start);
  };
  const setOut = () => {
    const at = clipAt(clips, playhead);
    if (!at || at.clip.id !== clip.id) return;
    set({ outPoint: Math.max(at.sourceTime, clip.inPoint + 0.1) });
  };

  if (clip.fill) {
    // A title card has no footage behind it, so the media rows would all be
    // blank. Show what can actually be changed.
    return (
      <div className="inspector">
        <h3>Title card</h3>
        <div className="kv">
          <span>Length</span><span>{fmtTime(clip.outPoint - clip.inPoint)}</span>
          <span>Colour</span>
          <span>
            <input
              type="color"
              value={clip.fill.color}
              onChange={(e) => set({ fill: { color: e.target.value } })}
            />
          </span>
        </div>
        <label className="angle">
          <span>Seconds</span>
          <input
            type="range" min={0.5} max={30} step={0.5}
            value={clip.outPoint - clip.inPoint}
            onChange={(e) => set({ outPoint: clip.inPoint + +e.target.value })}
          />
          <input
            type="number" min={0.5} max={60} step={0.5}
            value={clip.outPoint - clip.inPoint}
            onChange={(e) => set({ outPoint: clip.inPoint + Math.max(0.5, +e.target.value) })}
          />
          <span className="unit">s</span>
        </label>
        <p className="hint">
          The words come from an ordinary text card, so edit them in the Text tab — font,
          colour and fades all work as they do anywhere else. Changing the length here does
          not move the card; drag its ends on the timeline to match.
        </p>
      </div>
    );
  }

  return (
    <div className="inspector">
      <h3>Clip</h3>
      <div className="kv">
        <span>File</span><span title={clip.mediaPath}>{m?.name}</span>
        <span>Source</span><span>{m ? `${m.width}×${m.height} · ${m.fps.toFixed(2)} fps · ${m.videoCodec}` : "?"}</span>
        <span>Audio</span><span>{m?.hasAudio ? `${m.audioCodec} · ${m.audioChannels} ch` : "none (silence added)"}</span>
        <span>Stereo</span>
        <span>
          <select value={m?.stereoMode ?? "mono"} onChange={(e) => m && useStore.setState((s) => ({ media: { ...s.media, [m.path]: { ...m, stereoMode: e.target.value as never, stereoGuessed: false } } }))}>
            <option value="mono">Mono (2:1)</option>
            <option value="top-bottom">Stereo top-bottom</option>
            <option value="left-right">Stereo side-by-side</option>
          </select>
          {m?.stereoGuessed && <span className="hint"> guessed from aspect ratio</span>}
        </span>
        <span>360 tag</span><span>{m?.taggedSpherical ? "✓ source has spherical metadata" : "– none in source (export adds it)"}</span>
        <span>Size</span><span>{m ? fmtBytes(m.fileSize) : ""}</span>
      </div>

      <h3>Trim</h3>
      <div className="row">
        <button onClick={setIn} title="I">Set In at playhead</button>
        <button onClick={setOut} title="O">Set Out at playhead</button>
      </div>
      <div className="kv">
        <span>In</span><span>{fmtTime(clip.inPoint)}</span>
        <span>Out</span><span>{fmtTime(clip.outPoint)}</span>
        <span>Length</span><span>{fmtTime(clip.outPoint - clip.inPoint)}</span>
      </div>

      <h3>Orientation <span className="hint">(where the viewer starts looking)</span></h3>
      <Angle label="Yaw" value={clip.yaw} onChange={(yaw) => set({ yaw })} />
      <Angle label="Pitch" value={clip.pitch} onChange={(pitch) => set({ pitch })} min={-90} max={90} />
      <Angle label="Roll" value={clip.roll} onChange={(roll) => set({ roll })} />
      <div className="row">
        <button className="primary" onClick={setAsFront} title="Make the direction under the reticle the new front">
          ⌖ Set current view as front
        </button>
        <button onClick={() => set({ yaw: 0, pitch: 0, roll: 0 })}>Reset</button>
      </div>
      <p className="hint">
        Drag in the preview to look around, scroll to zoom. Exported with ffmpeg's <code>v360</code> filter
        (only re-projects when angles are non-zero).
      </p>
    </div>
  );
}
