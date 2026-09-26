import { useEffect, useState } from "react";
import { clipLength, fmtBytes, fmtTime, timelineDuration, useStore } from "../lib/store";
import { selectionDuration } from "../lib/selection";
import {
  cancelExport, ffmpegInfo, isTauri, onExportEvents, pickSavePath, revealInFinder, runExport,
  startExport, writeTextFile, type FfmpegInfo,
} from "../lib/tauri";
import type { ExportDone, Progress, StereoMode } from "../lib/types";
import { buildCavaCardFile, cavaSidecarPath } from "../lib/cavaExport";
import { CARD_MAX_W } from "../lib/cardRender";

const ENCODER_LABELS: Record<string, string> = {
  hevc_videotoolbox: "HEVC / H.265 — Apple hardware (fast, recommended)",
  h264_videotoolbox: "H.264 — Apple hardware (fast, widest compatibility)",
  libx265: "HEVC / H.265 — software x265 (slow, best quality)",
  libx264: "H.264 — software x264 (slow, best quality)",
  hevc_nvenc: "HEVC — NVIDIA hardware",
  h264_nvenc: "H.264 — NVIDIA hardware",
  libsvtav1: "AV1 — SVT (slow; YouTube ok, few VR players)",
  "libaom-av1": "AV1 — libaom (very slow)",
};

const RESOLUTIONS: [string, number, number][] = [
  ["Source resolution", 0, 0],
  ["8K · 7680×3840", 7680, 3840],
  ["5.7K · 5760×2880", 5760, 2880],
  ["4K · 3840×1920", 3840, 1920],
  ["2K · 2048×1024", 2048, 1024],
];

const PRESETS: { name: string; encoder: string; mbps: number; w: number; h: number }[] = [
  { name: "YouTube VR 8K", encoder: "hevc_videotoolbox", mbps: 100, w: 7680, h: 3840 },
  { name: "YouTube VR 4K", encoder: "h264_videotoolbox", mbps: 60, w: 3840, h: 1920 },
  { name: "Meta Quest (local file)", encoder: "hevc_videotoolbox", mbps: 60, w: 5760, h: 2880 },
  { name: "Vision Pro / Apple", encoder: "hevc_videotoolbox", mbps: 80, w: 0, h: 0 },
];

export function ExportPanel() {
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const cards = useStore((s) => s.cards);
  const settings = useStore((s) => s.exportSettings);
  const { setExportSettings, toggleClipSelected, setSelectedClips } = useStore.getState();

  const [info, setInfo] = useState<FfmpegInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState<ExportDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCmd, setShowCmd] = useState(false);
  const [sidecar, setSidecar] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) { setInfoError("Export needs the desktop app (run `npm run tauri dev`)."); return; }
    ffmpegInfo().then((i) => {
      setInfo(i);
      if (!i.encoders.includes(settings.encoder) && i.encoders.length) setExportSettings({ encoder: i.encoders[0] });
    }).catch((e) => setInfoError(String(e)));
    return onExportEvents({
      progress: setProgress,
      done: (d) => { setDone(d); setProgress(null); },
      error: (m) => { setError(m); setProgress(null); },
    });
  }, []);

  // Default stereo mode + suggest output name from the first clip.
  useEffect(() => {
    const first = media[clips[0]?.mediaPath];
    if (!first) return;
    if (!settings.output) {
      const base = first.path.replace(/\.[^.]+$/, "");
      setExportSettings({ output: `${base}_360.mp4`, stereoMode: first.stereoMode });
    }
  }, [clips.length]);

  const total = timelineDuration(clips);
  const activeCards = cards.filter((c) => c.end > c.start && c.text.trim() !== "").length;
  const filterCount = clips.reduce((n, c) => n + c.filters.length, 0);
  const selections = useStore((s) => s.selections);
  const selectedIds = useStore((s) => s.selectedClipIds);
  const chosenClips = clips.filter((c) => selectedIds.includes(c.id));
  const canScopeClips = chosenClips.length > 0;

  // What gets exported, and whether each clip becomes its own file.
  const [scope, setScope] = useState<"all" | "range" | "clips">("all");
  const [separateFiles, setSeparateFiles] = useState(false);
  const [batch, setBatch] = useState<{ index: number; of: number } | null>(null);

  const effectiveScope = scope === "range" && selections.length === 0 ? "all" : scope;
  const activeRanges = effectiveScope === "range" ? selections : [];
  const scopedClips = effectiveScope === "clips" ? chosenClips : clips;
  const nothingChosen = effectiveScope === "clips" && chosenClips.length === 0;
  const exportLength = effectiveScope === "clips"
    ? chosenClips.reduce((n, c) => n + (c.outPoint - c.inPoint), 0)
    : selectionDuration(clips, activeRanges);
  const running = progress !== null;
  const canExport = isTauri && clips.length > 0 && !!settings.output && !running && !nothingChosen;

  const choose = async () => {
    const p = await pickSavePath(settings.output || "export_360.mp4");
    if (p) setExportSettings({ output: p });
  };
  const saveSidecar = async () => {
    setError(null);
    try {
      const first = media[clips[0]?.mediaPath];
      const videoName = settings.output.split("/").pop() ?? "video.mp4";
      const file = buildCavaCardFile(cards, videoName, first?.stereoMode ?? "mono", CARD_MAX_W);
      const path = cavaSidecarPath(settings.output);
      await writeTextFile(path, JSON.stringify(file, null, 2));
      setSidecar(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const run = async () => {
    setDone(null); setError(null);
    setProgress({ percent: 0, outTime: 0, speed: "", fps: 0, stage: "starting" });
    try {
      if (effectiveScope === "clips" && separateFiles) {
        // One file per clip, run one at a time: the backend refuses a second
        // export while one is in flight.
        const dot = settings.output.lastIndexOf(".");
        const stem = dot > 0 ? settings.output.slice(0, dot) : settings.output;
        const ext = dot > 0 ? settings.output.slice(dot) : ".mp4";
        let last: ExportDone | null = null;
        for (let i = 0; i < chosenClips.length; i++) {
          setBatch({ index: i + 1, of: chosenClips.length });
          const numbered = `${stem}_${String(i + 1).padStart(2, "0")}${ext}`;
          last = await runExport(
            [chosenClips[i]], media, cards,
            { ...settings, output: numbered }, [], setProgress,
          );
        }
        setBatch(null);
        if (last) setDone(last);
        setProgress(null);
      } else {
        await startExport(scopedClips, media, cards, settings, activeRanges);
      }
    } catch (e) { setError(String(e)); setProgress(null); setBatch(null); }
  };

  const eta = progress && progress.percent > 1 && progress.speed
    ? (total - progress.outTime) / Math.max(0.01, parseFloat(progress.speed))
    : null;

  return (
    <div className="export">
      <h3>Export 360° / VR</h3>
      {infoError && <div className="error">{infoError}</div>}
      {info && <div className="hint" title={`${info.version}\n${info.path}`}>{info.version.split(" (")[0]}</div>}
      {info?.emulated && (
        <div className="warn">
          <b>ffmpeg is running under emulation — exports will be very slow</b>
          <div>
            The ffmpeg at <code>{info.path}</code> is {info.archs.join("/")}-only, but this Mac is{" "}
            {info.hostArch}. Translated code cannot use the hardware video encoder, so it falls back
            to software encoding (often 20× slower than realtime).
          </div>
          <div>Install a native build, then restart the app:</div>
          <pre className="cmd">brew install ffmpeg</pre>
        </div>
      )}

      <div className="row">
        <span className="hint">Presets:</span>
        {PRESETS.filter((p) => !info || info.encoders.includes(p.encoder)).map((p) => (
          <button key={p.name} className="chip" onClick={() => setExportSettings({ encoder: p.encoder, videoBitrateMbps: p.mbps, width: p.w, height: p.h })}>{p.name}</button>
        ))}
      </div>

      <label className="field">
        <span>Output</span>
        <div className="row">
          <input type="text" value={settings.output} onChange={(e) => setExportSettings({ output: e.target.value })} placeholder="/path/to/output_360.mp4" />
          <button onClick={choose}>Choose…</button>
        </div>
      </label>

      <label className="field">
        <span>Encoder</span>
        <select value={settings.encoder} onChange={(e) => setExportSettings({ encoder: e.target.value })}>
          {(info?.encoders ?? [settings.encoder]).map((e) => <option key={e} value={e}>{ENCODER_LABELS[e] ?? e}</option>)}
        </select>
      </label>

      <div className="grid2">
        <label className="field">
          <span>Resolution</span>
          <select value={`${settings.width}x${settings.height}`} onChange={(e) => { const [w, h] = e.target.value.split("x").map(Number); setExportSettings({ width: w, height: h }); }}>
            {RESOLUTIONS.map(([n, w, h]) => <option key={n} value={`${w}x${h}`}>{n}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Frame rate</span>
          <select value={settings.fps} onChange={(e) => setExportSettings({ fps: +e.target.value })}>
            <option value={0}>Source</option>
            {[24, 25, 29.97, 30, 50, 59.94, 60].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Video bitrate (Mbps)</span>
          <input type="number" min={5} max={400} value={settings.videoBitrateMbps} onChange={(e) => setExportSettings({ videoBitrateMbps: +e.target.value })} />
        </label>
        <label className="field">
          <span>Audio bitrate (kbps)</span>
          <select value={settings.audioBitrateKbps} onChange={(e) => setExportSettings({ audioBitrateKbps: +e.target.value })}>
            {[128, 192, 256, 320].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Stereo layout</span>
          <select value={settings.stereoMode} onChange={(e) => setExportSettings({ stereoMode: e.target.value as StereoMode })}>
            <option value="mono">Mono</option>
            <option value="top-bottom">Stereo top-bottom</option>
            <option value="left-right">Stereo side-by-side</option>
          </select>
        </label>
        <div className="field checks">
          <label><input type="checkbox" checked={settings.injectSpherical} onChange={(e) => setExportSettings({ injectSpherical: e.target.checked })} /> Write 360° metadata (v1 + v2)</label>
          <label><input type="checkbox" checked={settings.faststart} onChange={(e) => setExportSettings({ faststart: e.target.checked })} /> Fast start (web streaming)</label>
          <label><input type="checkbox" checked={settings.burnCards} onChange={(e) => setExportSettings({ burnCards: e.target.checked })} /> Burn text cards into the video</label>
        </div>
      </div>

      {cards.length > 0 && !settings.burnCards && (
        <div className="hint">
          Cards stay out of the pixels. Save them beside the video for CAVA360VR, where they
          become objects you can grab and move.
        </div>
      )}
      {cards.length > 0 && (
        <div className="row">
          <button onClick={saveSidecar} disabled={!isTauri || !settings.output}>
            Save cards for CAVA360VR (.cards.json)
          </button>
        </div>
      )}
      {sidecar && <div className="hint">Wrote {sidecar}</div>}

      <label className="field">
        <span>What to export</span>
        <select value={effectiveScope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">Whole timeline ({fmtTime(total)})</option>
          <option value="range" disabled={selections.length === 0}>
            {selections.length
              ? `Marked ranges (${selections.length}) — ${fmtTime(selectionDuration(clips, selections))}`
              : "Marked ranges — drag the ruler first"}
          </option>
          <option value="clips">
            {canScopeClips ? `Chosen clips (${chosenClips.length})` : "Chosen clips — pick below"}
          </option>
        </select>
      </label>

      {effectiveScope === "clips" && (
        <div className="clip-picker">
          <div className="row picker-head">
            <span className="hint">
              {chosenClips.length} of {clips.length} · {fmtTime(exportLength)}
            </span>
            <span className="spacer" />
            <button onClick={() => setSelectedClips(clips.map((c) => c.id))}>All</button>
            <button onClick={() => setSelectedClips([])} disabled={chosenClips.length === 0}>
              None
            </button>
            <button
              onClick={() =>
                setSelectedClips(clips.filter((c) => !selectedIds.includes(c.id)).map((c) => c.id))
              }
              title="Tick what is unticked and vice versa"
            >
              Invert
            </button>
          </div>
          <ul className="clip-list">
            {clips.map((c, i) => {
              const title = c.fill ? cards.find((k) => k.ownerClipId === c.id) : undefined;
              const name = c.fill
                ? (title?.text.split("\n")[0] ? `Title — ${title.text.split("\n")[0]}` : "Title card")
                : (media[c.mediaPath]?.name ?? c.mediaPath.split("/").pop() ?? c.mediaPath);
              return (
                <li key={c.id}>
                  <label title={c.fill ? undefined : c.mediaPath}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(c.id)}
                      onChange={() => toggleClipSelected(c.id)}
                    />
                    <span className="num">{i + 1}</span>
                    <span className="nm">{name}</span>
                    <span className="len">{fmtTime(clipLength(c))}</span>
                    {c.filters.length > 0 && (
                      <span className="fx" title={c.filters.map((f) => f.name).join(", ")}>
                        {c.filters.length} fx
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          {nothingChosen && <div className="warn">Tick at least one clip.</div>}
        </div>
      )}

      {effectiveScope === "clips" && !nothingChosen && (
        <label className="row">
          <input
            type="checkbox"
            checked={separateFiles}
            onChange={(e) => setSeparateFiles(e.target.checked)}
          />
          A separate file per clip
        </label>
      )}

      {effectiveScope === "clips" && separateFiles && !nothingChosen && (
        <div className="hint sel-note">
          {chosenClips.length} files, numbered from the name above, e.g.{" "}
          <span className="mono">{(settings.output.replace(/\.[^.]+$/, "") || "output") + "_01.mp4"}</span>.
        </div>
      )}
      {effectiveScope === "range" && selections.length > 0 && (
        <div className="hint sel-note">
          {selections.length === 1 ? "One range" : `${selections.length} ranges`}, joined in
          timeline order: {fmtTime(exportLength)} of {fmtTime(total)}.
        </div>
      )}

      <div className="row">
        <button className="primary big" onClick={run} disabled={!canExport}>
          {running
            ? "Exporting…"
            : `Export ${fmtTime(exportLength)} · ${scopedClips.length} clip${scopedClips.length === 1 ? "" : "s"}` +
              (activeCards && settings.burnCards ? ` · ${activeCards} card${activeCards === 1 ? "" : "s"}` : "") +
              (filterCount ? ` · ${filterCount} filter${filterCount === 1 ? "" : "s"}` : "")}
        </button>
        {running && <button className="danger" onClick={() => cancelExport()}>Cancel</button>}
      </div>

      {batch && (
        <div className="hint">Clip {batch.index} of {batch.of}…</div>
      )}
      {progress && (
        <div className="progress">
          <div className="bar"><div style={{ width: `${progress.percent}%` }} /></div>
          <div className="hint">
            {progress.stage} · {progress.percent.toFixed(1)}% · {fmtTime(progress.outTime)} / {fmtTime(total)}
            {progress.speed && ` · ${progress.speed}`}{progress.fps ? ` · ${progress.fps.toFixed(0)} fps` : ""}
            {eta !== null && ` · ~${fmtTime(eta)} left`}
          </div>
        </div>
      )}

      {error && <div className="error"><b>Export failed</b><pre>{error}</pre></div>}

      {done && (
        <div className="done">
          <b>Export complete</b> · {fmtBytes(done.fileSize)}
          <div className="verify">
            <Check ok={done.ffprobe.sphericalMapping} label={`ffprobe: Spherical Mapping${done.ffprobe.projection ? ` (${done.ffprobe.projection})` : ""}`} />
            <Check ok={!!done.boxes?.hasSv3d} label="sv3d box (v2, YouTube / Quest / Apple)" />
            <Check ok={!!done.boxes?.hasSt3d} label={`st3d box${done.boxes?.stereoMode ? ` · ${done.boxes.stereoMode}` : ""}`} />
            <Check ok={!!done.boxes?.hasV1Uuid} label="v1 RDF uuid (legacy players)" />
          </div>
          <div className="row">
            <button onClick={() => revealInFinder(done.output)}>Reveal in Finder</button>
            <button onClick={() => setShowCmd(!showCmd)}>{showCmd ? "Hide" : "Show"} ffmpeg command</button>
          </div>
          {showCmd && <pre className="cmd">{done.command}</pre>}
        </div>
      )}
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return <div className={ok ? "ok" : "bad"}>{ok ? "✓" : "✗"} {label}</div>;
}
