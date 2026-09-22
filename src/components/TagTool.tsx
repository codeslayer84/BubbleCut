import { useState } from "react";
import { isTauri, pickOpenPath, pickSavePath, probeMedia, revealInFinder, tagSpherical, type TagResult } from "../lib/tauri";
import type { StereoMode } from "../lib/types";

/** Add 360° metadata to an existing file without re-encoding. */
export function TagTool() {
  const [input, setInput] = useState("");
  const [stereo, setStereo] = useState<StereoMode>("mono");
  const [result, setResult] = useState<TagResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const p = await pickOpenPath("mp4");
    if (!p) return;
    setInput(p); setResult(null); setError(null);
    try { const m = await probeMedia(p); setStereo(m.stereoMode); } catch { /* ignore */ }
  };
  const run = async () => {
    const out = await pickSavePath(input.replace(/\.mp4$/i, "") + "_360.mp4");
    if (!out) return;
    setBusy(true); setError(null); setResult(null);
    try { setResult(await tagSpherical(input, out, stereo)); (window as any).__lastTag = out; }
    catch (e) { setError(String(e)); }
    setBusy(false);
  };

  if (!isTauri) return <div className="hint">Available in the desktop app.</div>;
  return (
    <div className="tagtool">
      <h3>Tag existing MP4 as 360°</h3>
      <p className="hint">Injects spherical metadata into an already-encoded file — no re-encode, seconds not hours.</p>
      <div className="row">
        <input type="text" value={input} readOnly placeholder="Choose an MP4…" />
        <button onClick={pick}>Choose…</button>
      </div>
      <div className="row">
        <select value={stereo} onChange={(e) => setStereo(e.target.value as StereoMode)}>
          <option value="mono">Mono</option>
          <option value="top-bottom">Stereo top-bottom</option>
          <option value="left-right">Stereo side-by-side</option>
        </select>
        <button className="primary" disabled={!input || busy} onClick={run}>{busy ? "Writing…" : "Tag & save as…"}</button>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="done">
          <div className={result.ffprobe.sphericalMapping ? "ok" : "bad"}>
            {result.ffprobe.sphericalMapping ? "✓" : "✗"} ffprobe sees Spherical Mapping
            {result.ffprobe.stereo3d ? ` · Stereo 3D: ${result.ffprobe.stereo3d}` : ""}
          </div>
          <div className="hint">{result.inject.tracksTagged} track(s) tagged, moov grew {result.inject.moovDeltaBytes} bytes{result.inject.promotedCo64 ? ", stco→co64" : ""}</div>
          <button onClick={() => revealInFinder((window as any).__lastTag)}>Reveal in Finder</button>
        </div>
      )}
    </div>
  );
}
