import { create } from "zustand";
import type { Clip, ExportSettings, MediaInfo, ProjectFile, TextCard } from "./types";

const newId = () => Math.random().toString(36).slice(2, 10);

export const defaultExportSettings: ExportSettings = {
  output: "",
  encoder: "hevc_videotoolbox",
  width: 0,
  height: 0,
  fps: 0,
  videoBitrateMbps: 60,
  audioBitrateKbps: 192,
  stereoMode: "mono",
  faststart: true,
  injectSpherical: true,
  burnCards: true,
};

/** Look direction of the preview camera (degrees), independent of clips. */
export interface View {
  lon: number;
  lat: number;
  fov: number;
}

export const defaultCard = (start: number, end: number, yaw: number, pitch: number): TextCard => ({
  id: Math.random().toString(36).slice(2, 10),
  text: "New text",
  start,
  end,
  yaw,
  pitch,
  roll: 0,
  widthDeg: 40,
  fadeIn: 0.5,
  fadeOut: 0.5,
  fontSize: 120,
  bold: true,
  color: "#ffffff",
  bgColor: "#000000",
  bgOpacity: 0.55,
  padding: 48,
  radius: 32,
  align: "center",
  shadow: true,
});

interface State {
  media: Record<string, MediaInfo>;
  clips: Clip[];
  cards: TextCard[];
  selectedClipId: string | null;
  selectedCardId: string | null;
  playhead: number;
  playing: boolean;
  view: View;
  exportSettings: ExportSettings;
  projectPath: string | null;
  dirty: boolean;

  addMedia: (m: MediaInfo, appendToTimeline?: boolean) => void;
  removeMedia: (path: string) => void;
  appendClip: (mediaPath: string) => void;
  addCard: (card: TextCard) => void;
  updateCard: (id: string, patch: Partial<TextCard>) => void;
  removeCard: (id: string) => void;
  selectCard: (id: string | null) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, dir: -1 | 1) => void;
  splitAtPlayhead: () => void;
  selectClip: (id: string | null) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setView: (v: Partial<View>) => void;
  setExportSettings: (s: Partial<ExportSettings>) => void;
  loadProject: (p: ProjectFile, path: string | null) => void;
  markSaved: (path: string) => void;
  newProject: () => void;
}

export const useStore = create<State>((set, get) => ({
  media: {},
  clips: [],
  cards: [],
  selectedClipId: null,
  selectedCardId: null,
  playhead: 0,
  playing: false,
  view: { lon: 0, lat: 0, fov: 90 },
  exportSettings: defaultExportSettings,
  projectPath: null,
  dirty: false,

  addMedia: (m, appendToTimeline = true) => {
    set((s) => ({ media: { ...s.media, [m.path]: m }, dirty: true }));
    if (appendToTimeline) get().appendClip(m.path);
  },
  removeMedia: (path) =>
    set((s) => {
      const media = { ...s.media };
      delete media[path];
      return { media, clips: s.clips.filter((c) => c.mediaPath !== path), dirty: true };
    }),
  appendClip: (mediaPath) =>
    set((s) => {
      const m = s.media[mediaPath];
      if (!m) return {};
      const clip: Clip = {
        id: newId(),
        mediaPath,
        inPoint: 0,
        outPoint: m.duration,
        yaw: 0,
        pitch: 0,
        roll: 0,
      };
      // Park the playhead on the new clip so the preview shows what's being edited.
      return {
        clips: [...s.clips, clip],
        selectedClipId: clip.id,
        playhead: timelineDuration(s.clips),
        playing: false,
        dirty: true,
      };
    }),
  addCard: (card) => set((s) => ({ cards: [...s.cards, card], selectedCardId: card.id, dirty: true })),
  updateCard: (id, patch) =>
    set((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)), dirty: true })),
  removeCard: (id) =>
    set((s) => ({
      cards: s.cards.filter((c) => c.id !== id),
      selectedCardId: s.selectedCardId === id ? null : s.selectedCardId,
      dirty: true,
    })),
  selectCard: (id) => set({ selectedCardId: id }),
  updateClip: (id, patch) =>
    set((s) => ({
      clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      dirty: true,
    })),
  removeClip: (id) =>
    set((s) => ({
      clips: s.clips.filter((c) => c.id !== id),
      selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
      dirty: true,
    })),
  moveClip: (id, dir) =>
    set((s) => {
      const i = s.clips.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.clips.length) return {};
      const clips = [...s.clips];
      [clips[i], clips[j]] = [clips[j], clips[i]];
      return { clips, dirty: true };
    }),
  splitAtPlayhead: () =>
    set((s) => {
      const t = s.playhead;
      let start = 0;
      for (let i = 0; i < s.clips.length; i++) {
        const c = s.clips[i];
        const len = c.outPoint - c.inPoint;
        const local = t - start;
        // Only split strictly inside a clip (avoid zero-length pieces).
        if (local > 0.05 && local < len - 0.05) {
          const cut = c.inPoint + local;
          const a = { ...c, outPoint: cut };
          const b = { ...c, id: newId(), inPoint: cut };
          const clips = [...s.clips.slice(0, i), a, b, ...s.clips.slice(i + 1)];
          return { clips, selectedClipId: b.id, dirty: true };
        }
        start += len;
      }
      return {};
    }),
  selectClip: (id) => set({ selectedClipId: id }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  setExportSettings: (p) =>
    set((s) => ({ exportSettings: { ...s.exportSettings, ...p }, dirty: true })),
  loadProject: (p, path) =>
    set({
      media: Object.fromEntries(p.media.map((m) => [m.path, m])),
      clips: p.clips,
      // Older projects predate fades, so the fields may be missing at runtime.
      cards: (p.cards ?? []).map((c) => ({ ...c, fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0 })),
      selectedClipId: p.clips[0]?.id ?? null,
      selectedCardId: null,
      playhead: 0,
      playing: false,
      exportSettings: { ...defaultExportSettings, ...p.exportSettings },
      projectPath: path,
      dirty: false,
    }),
  markSaved: (path) => set({ projectPath: path, dirty: false }),
  newProject: () =>
    set({
      media: {},
      clips: [],
      cards: [],
      selectedClipId: null,
      selectedCardId: null,
      playhead: 0,
      playing: false,
      exportSettings: defaultExportSettings,
      projectPath: null,
      dirty: false,
    }),
}));

// ------------------------------------------------------------ selectors --

export const clipLength = (c: Clip) => Math.max(0, c.outPoint - c.inPoint);

export function timelineDuration(clips: Clip[]) {
  return clips.reduce((a, c) => a + clipLength(c), 0);
}

export interface ClipAt {
  clip: Clip;
  index: number;
  /** Timeline time at which this clip starts. */
  start: number;
  /** Time inside the source media. */
  sourceTime: number;
}

export function clipAt(clips: Clip[], t: number): ClipAt | null {
  let start = 0;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const len = clipLength(c);
    if (t < start + len || i === clips.length - 1) {
      const local = Math.min(Math.max(0, t - start), len);
      return { clip: c, index: i, start, sourceTime: c.inPoint + local };
    }
    start += len;
  }
  return null;
}

export function clipStart(clips: Clip[], id: string) {
  let start = 0;
  for (const c of clips) {
    if (c.id === id) return start;
    start += clipLength(c);
  }
  return 0;
}

export function toProjectFile(s: State): ProjectFile {
  return {
    version: 1,
    media: Object.values(s.media).map(({ blobUrl: _b, ...m }) => m),
    clips: s.clips,
    cards: s.cards,
    exportSettings: s.exportSettings,
  };
}

export const fmtTime = (t: number) => {
  if (!isFinite(t)) return "0:00.00";
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
};

export const fmtBytes = (b: number) =>
  b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} kB`;
