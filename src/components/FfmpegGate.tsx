import { useEffect, useState } from "react";
import { ffmpegInfo, isTauri, type FfmpegInfo } from "../lib/tauri";

type Platform = "mac" | "windows" | "linux";

function currentPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "mac";
  return "linux";
}

const INSTALL: Record<Platform, { label: string; command: string; note?: string }> = {
  mac: {
    label: "macOS — with Homebrew",
    command: "brew install ffmpeg",
    note: "On Apple silicon this gives a native build. An Intel build under Rosetta cannot reach the hardware encoder and exports around 20× slower.",
  },
  windows: {
    label: "Windows — with winget",
    command: "winget install Gyan.FFmpeg",
    note: "Open a new terminal afterwards so the updated PATH is picked up.",
  },
  linux: {
    label: "Linux — Debian or Ubuntu",
    command: "sudo apt install ffmpeg",
  },
};

/**
 * FFmpeg is not bundled: a redistributable build would oblige us to ship its
 * source, and the convenient prebuilt ones are non-free. So the app checks for
 * it at startup and says plainly what to install if it is missing.
 */
export function FfmpegGate() {
  const [state, setState] = useState<"checking" | "ok" | "missing">("checking");
  const [info, setInfo] = useState<FfmpegInfo | null>(null);
  const [error, setError] = useState<string>("");
  const [dismissed, setDismissed] = useState(false);

  const check = () => {
    // Dev only: ?ffmpeg-missing forces the prompt so it can be looked at
    // without uninstalling ffmpeg.
    if (import.meta.env.DEV && location.search.includes("ffmpeg-missing")) {
      setError("ffmpeg not found. Install ffmpeg (e.g. `brew install ffmpeg`) or set BUBBLECUT_FFMPEG_DIR.");
      setState("missing");
      return;
    }
    if (!isTauri) { setState("ok"); return; }
    setState("checking");
    ffmpegInfo()
      .then((i) => { setInfo(i); setState("ok"); })
      .catch((e) => { setError(String(e)); setState("missing"); });
  };

  useEffect(check, []);

  if (state !== "missing" || dismissed) return null;

  const platform = currentPlatform();
  const how = INSTALL[platform];

  return (
    <div className="modal-backdrop">
      <div className="modal ffmpeg-gate">
        <h2>FFmpeg is needed</h2>
        <p className="about-desc">
          Bubblecut uses FFmpeg to read and write video. It is not included, because
          redistributing it carries its own licence obligations, so it has to be installed
          once on this machine.
        </p>

        <h3>{how.label}</h3>
        <div className="row">
          <pre className="cmd gate-cmd">{how.command}</pre>
          <button onClick={() => navigator.clipboard?.writeText(how.command)}>Copy</button>
        </div>
        {how.note && <p className="hint">{how.note}</p>}

        <p className="hint">
          Or download a build from <span className="mono">ffmpeg.org/download.html</span> and put
          <span className="mono"> ffmpeg</span> and <span className="mono">ffprobe</span> on your PATH.
          If you keep them somewhere else, point the app at that folder with the
          <span className="mono"> BUBBLECUT_FFMPEG_DIR</span> environment variable.
        </p>

        <details>
          <summary className="hint">What the app looked for</summary>
          <pre className="cmd">{error}</pre>
        </details>

        <div className="row">
          <button className="primary" onClick={check}>Check again</button>
          <span className="spacer" />
          <button onClick={() => setDismissed(true)}>Continue without it</button>
        </div>
        <p className="hint">
          Without FFmpeg you can still open a project, but importing and exporting will fail.
        </p>
        {info ? <div className="hint">{info.version}</div> : null}
      </div>
    </div>
  );
}
