import { useEffect, useState } from "react";
import { ffmpegInfo, isTauri, type FfmpegInfo } from "../lib/tauri";
// Imported rather than referenced by path so Vite fingerprints the filename.
// A fixed /app-icon.png stays in the webview's cache across a redesign.
import appIcon from "../assets/app-icon.png";

const VERSION = "0.1.2";

/** Ten lines on what this is, also used as the app's description. */
export const DESCRIPTION = [
  "Bubblecut is a desktop editor for 360° video, built for research recordings",
  "rather than for broadcast. It imports equirectangular footage, mono or stereo,",
  "and previews it as a real sphere you can look around in.",
  "Clips can be trimmed, split and reordered, and each one can be turned so the",
  "viewer starts facing whatever matters in the room.",
  "Text cards can be placed anywhere in the sphere, timed on the timeline and",
  "faded in and out — burned into the picture, or exported as a sidecar so they",
  "become objects you can grab and move in CAVA360VR.",
  "Painterly and anonymising filters run on the GPU, per clip, and can be saved",
  "as presets. FFmpeg does the decoding and the hardware encoding throughout.",
];

export function About({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<FfmpegInfo | null>(null);

  useEffect(() => {
    if (isTauri) ffmpegInfo().then(setInfo).catch(() => setInfo(null));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal about" onPointerDown={(e) => e.stopPropagation()}>
        <div className="about-head">
          <img src={appIcon} alt="" width={72} height={72} />
          <div>
            <h2>Bubblecut</h2>
            <div className="hint">Version {VERSION}</div>
          </div>
        </div>

        <p className="about-desc">{DESCRIPTION.join(" ")}</p>

        <div className="about-legal">
          <div>© {new Date().getFullYear()} Jacob Davidsen · Big Soft Video · Aalborg University</div>
          <div className="hint">Licensed under GPL-3.0-or-later.</div>
        </div>

        <h3>Credits</h3>
        <ul className="about-credits">
          <li>
            Image filters based on <b>360mash</b> — Big Soft Video, Aalborg University
            (<span className="mono">bigvideo.aau.dk</span>)
          </li>
          <li>
            Card export targets <b>CAVA360VR</b> — Aalborg University
          </li>
          <li>
            Decoding, filtering and encoding by <b>FFmpeg</b> (<span className="mono">ffmpeg.org</span>)
            {info ? <span className="hint"> — {info.version.split(" (")[0].replace("ffmpeg version ", "")}</span> : null}
          </li>
          <li>Built with Tauri, React, three.js and wgpu</li>
          <li>360° metadata follows Google's Spherical Video V2 specification</li>
        </ul>

        <div className="row">
          <span className="spacer" />
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
