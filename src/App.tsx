import { useEffect, useState } from "react";
import { Viewer } from "./components/Viewer";
import { Timeline } from "./components/Timeline";
import { Inspector } from "./components/Inspector";
import { MediaBin } from "./components/MediaBin";
import { ExportPanel } from "./components/ExportPanel";
import { CardPanel } from "./components/CardPanel";
import { FilterPanel } from "./components/FilterPanel";
import { About } from "./components/About";
import { FfmpegGate } from "./components/FfmpegGate";
import { TagTool } from "./components/TagTool";
import { clipAt, toProjectFile, useStore, type RightTab } from "./lib/store";
import { isTauri, pickOpenPath, pickSavePath, readTextFile, writeTextFile } from "./lib/tauri";
import type { ProjectFile } from "./lib/types";
import "./app.css";

export default function App() {
  const [showAbout, setShowAbout] = useState(false);
  const tab = useStore((s) => s.rightTab);
  const setTab = useStore((s) => s.setRightTab);
  const projectPath = useStore((s) => s.projectPath);
  const dirty = useStore((s) => s.dirty);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tgt.tagName)) return;
      const s = useStore.getState();
      const at = clipAt(s.clips, s.playhead);
      const fps = at ? s.media[at.clip.mediaPath]?.fps || 30 : 30;
      switch (e.key) {
        case " ": e.preventDefault(); s.setPlaying(!s.playing); break;
        case "Home": s.setPlaying(false); s.setPlayhead(0); break;
        case "ArrowLeft": s.setPlaying(false); s.setPlayhead(s.playhead - (e.shiftKey ? 1 : 1 / fps)); break;
        case "ArrowRight": s.setPlaying(false); s.setPlayhead(s.playhead + (e.shiftKey ? 1 : 1 / fps)); break;
        case "s": case "S": s.splitAtPlayhead(); break;
        case "i": case "I":
          if (at) { s.updateClip(at.clip.id, { inPoint: Math.min(at.sourceTime, at.clip.outPoint - 0.1) }); s.setPlayhead(at.start); }
          break;
        case "o": case "O":
          if (at) s.updateClip(at.clip.id, { outPoint: Math.max(at.sourceTime, at.clip.inPoint + 0.1) });
          break;
        case "Delete": case "Backspace":
          if (s.selectedClipId) s.removeClip(s.selectedClipId);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const save = async (as = false) => {
    let path = useStore.getState().projectPath;
    if (!path || as) path = await pickSavePath("project.360edit.json", "json");
    if (!path) return;
    await writeTextFile(path, JSON.stringify(toProjectFile(useStore.getState()), null, 2));
    useStore.getState().markSaved(path);
  };
  const open = async () => {
    const path = await pickOpenPath("json");
    if (!path) return;
    const p = JSON.parse(await readTextFile(path)) as ProjectFile;
    useStore.getState().loadProject(p, path);
  };

  return (
    <div className="app">
      <header>
        <div className="brand">Bubblecut</div>
        <nav>
          {(["edit", "vredit", "filters", "export", "tools"] as RightTab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "edit" ? "Edit" : t === "vredit" ? "VRedit" : t === "filters" ? "Filters"
                : t === "export" ? "Export" : "Tools"}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button onClick={() => setShowAbout(true)} title="About Bubblecut">About</button>
        {isTauri && (
          <div className="project">
            <span className="hint">{projectPath ? projectPath.split("/").pop() : "Untitled"}{dirty ? " •" : ""}</span>
            <button onClick={() => useStore.getState().newProject()}>New</button>
            <button onClick={open}>Open…</button>
            <button onClick={() => save(false)}>Save</button>
            <button onClick={() => save(true)}>Save as…</button>
          </div>
        )}
      </header>

      <main>
        <aside className="left">
          <MediaBin />
        </aside>
        <section className="center">
          <Viewer />
          <Timeline />
        </section>
        <aside className="right">
          {tab === "edit" && <Inspector />}
          {tab === "vredit" && <CardPanel />}
          {tab === "filters" && <FilterPanel />}
          {tab === "export" && <ExportPanel />}
          {tab === "tools" && <TagTool />}
        </aside>
      </main>

      <FfmpegGate />
      {showAbout && <About onClose={() => setShowAbout(false)} />}
    </div>
  );
}
