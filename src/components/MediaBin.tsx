import { useEffect, useState } from "react";
import { fmtTime, useStore } from "../lib/store";
import { isTauri, pickAudioFiles, pickVideoFiles, probeInBrowser, probeMedia } from "../lib/tauri";

export function MediaBin() {
  const media = useStore((s) => s.media);
  const { addMedia, appendClip, removeMedia, addAudio } = useStore.getState();
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

  const importAudio = async () => {
    setError(null);
    if (!isTauri) {
      setError("Importing audio needs the desktop app.");
      return;
    }
    const paths = await pickAudioFiles();
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
      <div className="row">
        <button onClick={importAudio} disabled={busy} title="Music or narration for the audio lane">
          + Import audio
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <ul>
        {Object.values(media).map((m) => (
          <li key={m.path} className={m.kind === "audio" ? "audio-item" : undefined}>
            <div className="media-name" title={m.path}>
              {m.kind === "audio" && <span className="kind">♪</span>}
              {m.name}
            </div>
            <div className="media-meta">
              {m.kind === "audio"
                ? `${fmtTime(m.duration)} · ${m.audioCodec ?? "?"} · ${m.audioChannels}ch`
                : `${m.width}×${m.height} · ${fmtTime(m.duration)} · ${m.stereoMode}${m.taggedSpherical ? " · 360✓" : ""}`}
            </div>
            <div className="row">
              {m.kind === "audio" ? (
                <button
                  onClick={() => addAudio(m.path, m.duration, useStore.getState().playhead)}
                  title="Drop it on the audio lane at the playhead"
                >
                  Add at playhead
                </button>
              ) : (
                <button onClick={() => appendClip(m.path)}>Add to timeline</button>
              )}
              <button onClick={() => removeMedia(m.path)} className="danger">×</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
