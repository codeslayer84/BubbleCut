import { useEffect, useState } from "react";
import { fmtTime, useStore } from "../lib/store";
import { isTauri, pickVideoFiles, probeInBrowser, probeMedia } from "../lib/tauri";

export function MediaBin() {
  const media = useStore((s) => s.media);
  const { addMedia, appendClip, removeMedia } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Browser dev convenience: `?dev` auto-loads the labelled test clip.
  useEffect(() => {
    if (isTauri || !location.search.includes("dev") || (window as any).__devLoaded) return;
    (window as any).__devLoaded = true;
    fetch("/dev/labelled.mp4").then((r) => r.blob())
      .then((b) => probeInBrowser(new File([b], "labelled.mp4", { type: "video/mp4" })))
      .then((m) => addMedia(m)).catch((e) => setError(String(e)));
  }, []);

  const importFiles = async () => {
    setError(null);
    if (!isTauri) {
      const input = document.createElement("input");
      input.type = "file"; input.multiple = true; input.accept = "video/*";
      input.onchange = async () => {
        for (const f of Array.from(input.files ?? [])) {
          try { addMedia(await probeInBrowser(f)); } catch (e) { setError(String(e)); }
        }
      };
      input.click();
      return;
    }
    const paths = await pickVideoFiles();
    setBusy(true);
    for (const p of paths) {
      try { addMedia(await probeMedia(p)); } catch (e) { setError(`${p}: ${e}`); }
    }
    setBusy(false);
  };

  return (
    <div className="media-bin">
      <div className="row">
        <button className="primary" onClick={importFiles} disabled={busy}>{busy ? "Probing…" : "+ Import 360° video"}</button>
      </div>
      {error && <div className="error">{error}</div>}
      <ul>
        {Object.values(media).map((m) => (
          <li key={m.path}>
            <div className="media-name" title={m.path}>{m.name}</div>
            <div className="media-meta">
              {m.width}×{m.height} · {fmtTime(m.duration)} · {m.stereoMode}{m.taggedSpherical ? " · 360✓" : ""}
            </div>
            <div className="row">
              <button onClick={() => appendClip(m.path)}>Add to timeline</button>
              <button onClick={() => removeMedia(m.path)} className="danger">×</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
