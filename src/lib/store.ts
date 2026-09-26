import { create } from "zustand";
import { loadPresets, savePresets, type FilterPreset } from "./presets";
import { clampPanel, loadPanels, PANEL_DEFAULTS, savePanels, type PanelSizes } from "./layout";
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

export interface TimeRange {
  id: string;
  start: number;
  end: number;
}

export type RightTab = "edit" | "vredit" | "filters" | "export" | "tools";

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
  previewFilters: boolean;
  /** Ranges of the timeline to export, in timeline seconds. Empty = all of it. */
  selections: TimeRange[];
  /** Which panel the right sidebar is showing. */
  rightTab: RightTab;
  /** Saved filter chains, shared across projects. */
  presets: FilterPreset[];
  selectedClipId: string | null;
  /** All clips picked out for export. The last one is selectedClipId. */
  selectedClipIds: string[];
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
  addTitleClip: (text: string, seconds: number, color: string) => void;
  addFilter: (clipId: string, name: string, params: Record<string, number>) => void;
  updateFilter: (clipId: string, id: string, params: Record<string, number>) => void;
  removeFilter: (clipId: string, id: string) => void;
  moveFilter: (clipId: string, id: string, dir: -1 | 1) => void;
  copyFiltersToAllClips: (clipId: string) => void;
  setPreviewFilters: (on: boolean) => void;
  addSelection: (range: { start: number; end: number }) => string | null;
  updateSelection: (id: string, range: { start: number; end: number }) => void;
  removeSelection: (id: string) => void;
  clearSelections: () => void;
  setRightTab: (tab: RightTab) => void;
  refreshPresets: () => Promise<void>;
  savePresetFromClip: (clipId: string, name: string) => Promise<string | null>;
  deletePreset: (name: string) => Promise<void>;
  applyPresetToClip: (clipId: string, name: string) => void;
  addCard: (card: TextCard) => void;
  updateCard: (id: string, patch: Partial<TextCard>) => void;
  removeCard: (id: string) => void;
  selectCard: (id: string | null) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  removeClip: (id: string) => void;
  moveClip: (id: string, dir: -1 | 1) => void;
  splitAtPlayhead: () => void;
  selectClip: (id: string | null) => void;
  panels: PanelSizes;
  setPanel: (which: keyof PanelSizes, px: number) => void;
  resetPanel: (which: keyof PanelSizes) => void;
  toggleClipSelected: (id: string) => void;
  setSelectedClips: (ids: string[]) => void;
  selectClipRange: (id: string) => void;
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
  previewFilters: true,
  selections: [],
  rightTab: "edit",
  presets: [],
  selectedClipId: null,
  selectedClipIds: [],
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
        filters: [],
      };
      // Park the playhead on the new clip so the preview shows what's being edited.
      const clips = [...s.clips, clip];
      return {
        clips,
        cards: syncTitleCards(clips, s.cards),
        selectedClipId: clip.id,
        playhead: timelineDuration(s.clips),
        playing: false,
        dirty: true,
      };
    }),
  // A title is a coloured clip with a text card over it. Inserted at the
  // playhead, splitting whatever is there, which is where an editor would
  // expect a caption card to land.
  addTitleClip: (text, seconds, color) =>
    set((s) => {
      let clips = [...s.clips];
      let at = 0;
      let index = clips.length;
      for (let i = 0; i < clips.length; i++) {
        const len = clipLength(clips[i]);
        const local = s.playhead - at;
        if (local > 0.05 && local < len - 0.05) {
          const cut = clips[i].inPoint + local;
          const a = { ...clips[i], outPoint: cut };
          const b = { ...clips[i], id: newId(), inPoint: cut };
          clips = [...clips.slice(0, i), a, b, ...clips.slice(i + 1)];
          index = i + 1;
          at += local;
          break;
        }
        if (Math.abs(local) <= 0.05) { index = i; break; }
        at += len;
        index = i + 1;
      }

      const title: Clip = {
        id: newId(),
        mediaPath: "",
        inPoint: 0,
        outPoint: seconds,
        yaw: 0,
        pitch: 0,
        roll: 0,
        filters: [],
        fill: { color },
      };
      clips.splice(index, 0, title);

      const card = defaultCard(at, at + seconds, 0, 0);
      card.ownerClipId = title.id;
      card.text = text;
      card.bgOpacity = 0;      // the clip is already the background
      card.fadeIn = 0.4;
      card.fadeOut = 0.4;

      return {
        clips,
        cards: syncTitleCards(clips, [...s.cards, card]),
        selectedClipId: title.id,
        selectedClipIds: [title.id],
        selectedCardId: card.id,
        dirty: true,
      };
    }),

  addFilter: (clipId, name, params) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId
          ? { ...c, filters: [...c.filters, { id: newId(), name, params }] }
          : c,
      ),
      dirty: true,
    })),
  updateFilter: (clipId, id, params) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId
          ? {
              ...c,
              filters: c.filters.map((f) =>
                f.id === id ? { ...f, params: { ...f.params, ...params } } : f,
              ),
            }
          : c,
      ),
      dirty: true,
    })),
  removeFilter: (clipId, id) =>
    set((s) => ({
      clips: s.clips.map((c) =>
        c.id === clipId ? { ...c, filters: c.filters.filter((f) => f.id !== id) } : c,
      ),
      dirty: true,
    })),
  moveFilter: (clipId, id, dir) =>
    set((s) => ({
      clips: s.clips.map((c) => {
        if (c.id !== clipId) return c;
        const i = c.filters.findIndex((f) => f.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= c.filters.length) return c;
        const filters = [...c.filters];
        [filters[i], filters[j]] = [filters[j], filters[i]];
        return { ...c, filters };
      }),
      dirty: true,
    })),
  copyFiltersToAllClips: (clipId) =>
    set((s) => {
      const source = s.clips.find((c) => c.id === clipId);
      if (!source) return {};
      return {
        clips: s.clips.map((c) => ({
          ...c,
          // Fresh ids, so each clip's filters can be edited independently.
          filters: source.filters.map((f) => ({ ...f, id: newId(), params: { ...f.params } })),
        })),
        dirty: true,
      };
    }),
  setPreviewFilters: (previewFilters) => set({ previewFilters }),
  // Each drag adds a range rather than replacing the last, so several parts
  // of a recording can be picked out in one pass.
  addSelection: (range) => {
    const start = Math.max(0, Math.min(range.start, range.end));
    const end = Math.max(range.start, range.end);
    if (end - start < 0.05) return null;
    const id = newId();
    set((s) => ({ selections: [...s.selections, { id, start, end }] }));
    return id;
  },
  updateSelection: (id, range) =>
    set((s) => ({
      selections: s.selections.map((r) =>
        r.id === id
          ? { ...r, start: Math.max(0, Math.min(range.start, range.end)), end: Math.max(range.start, range.end) }
          : r,
      ),
    })),
  removeSelection: (id) => set((s) => ({ selections: s.selections.filter((r) => r.id !== id) })),
  clearSelections: () => set({ selections: [] }),
  setRightTab: (rightTab) => set({ rightTab }),

  refreshPresets: async () => set({ presets: await loadPresets() }),

  savePresetFromClip: async (clipId, name) => {
    const clip = get().clips.find((c) => c.id === clipId);
    if (!clip) return "no clip selected";
    const preset: FilterPreset = {
      name: name.trim(),
      filters: clip.filters.map((f) => ({ name: f.name, params: { ...f.params } })),
    };
    // Saving under an existing name replaces it, which is what "save" means
    // when you have tweaked a look and want to keep the new version.
    const list = [...get().presets.filter((p) => p.name !== preset.name), preset]
      .sort((a, b) => a.name.localeCompare(b.name));
    set({ presets: list });
    try {
      await savePresets(list);
    } catch (e) {
      return String(e);
    }
    return null;
  },

  deletePreset: async (name) => {
    const list = get().presets.filter((p) => p.name !== name);
    set({ presets: list });
    await savePresets(list);
  },

  applyPresetToClip: (clipId, name) =>
    set((s) => {
      const preset = s.presets.find((p) => p.name === name);
      if (!preset) return {};
      return {
        clips: s.clips.map((c) =>
          c.id === clipId
            ? {
                ...c,
                // Fresh ids so the applied filters edit independently of the
                // preset they came from.
                filters: preset.filters.map((f) => ({
                  id: newId(),
                  name: f.name,
                  params: { ...f.params },
                })),
              }
            : c,
        ),
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
    set((s) => {
      const clips = s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c));
      return { clips, cards: syncTitleCards(clips, s.cards), dirty: true };
    }),
  removeClip: (id) =>
    set((s) => {
      const clips = s.clips.filter((c) => c.id !== id);
      // A title's words belong to it, so they go too.
      const cards = syncTitleCards(clips, s.cards.filter((k) => k.ownerClipId !== id));
      return {
        clips,
        cards,
        selectedClipIds: s.selectedClipIds.filter((x) => x !== id),
        selectedClipId: s.selectedClipId === id ? null : s.selectedClipId,
        dirty: true,
      };
    }),
  moveClip: (id, dir) =>
    set((s) => {
      const i = s.clips.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.clips.length) return {};
      const clips = [...s.clips];
      [clips[i], clips[j]] = [clips[j], clips[i]];
      return { clips, cards: syncTitleCards(clips, s.cards), dirty: true };
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
          return { clips, cards: syncTitleCards(clips, s.cards), selectedClipId: b.id, dirty: true };
        }
        start += len;
      }
      return {};
    }),
  selectClip: (id) => set({ selectedClipId: id, selectedClipIds: id ? [id] : [] }),

  // Cmd- or Ctrl-click: add or remove one clip.
  panels: loadPanels(),
  setPanel: (which, px) =>
    set((s) => {
      const panels = { ...s.panels, [which]: clampPanel(which, px) };
      savePanels(panels);
      return { panels };
    }),
  resetPanel: (which) =>
    set((s) => {
      const panels = { ...s.panels, [which]: PANEL_DEFAULTS[which] };
      savePanels(panels);
      return { panels };
    }),

  toggleClipSelected: (id) =>
    set((s) => {
      const has = s.selectedClipIds.includes(id);
      const want = has ? s.selectedClipIds.filter((x) => x !== id) : [...s.selectedClipIds, id];
      // Held in timeline order however they were clicked, so anything reading the
      // list gets the same order the export does.
      const ids = s.clips.map((c) => c.id).filter((x) => want.includes(x));
      return {
        selectedClipId: has ? (ids.length ? ids[ids.length - 1] : null) : id,
        selectedClipIds: ids,
      };
    }),

  // Whole list at once, for the export tab's tick-list.
  setSelectedClips: (ids) =>
    set((s) => {
      const order = s.clips.map((c) => c.id);
      const kept = order.filter((id) => ids.includes(id)); // timeline order, no strays
      return {
        selectedClipIds: kept,
        selectedClipId: kept.length
          ? (s.selectedClipId && kept.includes(s.selectedClipId) ? s.selectedClipId : kept[0])
          : null,
      };
    }),

  // Shift-click: everything between the current clip and this one.
  selectClipRange: (id) =>
    set((s) => {
      const order = s.clips.map((c) => c.id);
      const to = order.indexOf(id);
      const anchor = s.selectedClipId ? order.indexOf(s.selectedClipId) : to;
      if (to < 0 || anchor < 0) return {};
      const [lo, hi] = anchor <= to ? [anchor, to] : [to, anchor];
      return { selectedClipIds: order.slice(lo, hi + 1), selectedClipId: id };
    }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  setExportSettings: (p) =>
    set((s) => ({ exportSettings: { ...s.exportSettings, ...p }, dirty: true })),
  loadProject: (p, path) =>
    set({
      media: Object.fromEntries(p.media.map((m) => [m.path, m])),
      // Older projects predate fades, so the fields may be missing at runtime.
      cards: (p.cards ?? []).map((c) => ({ ...c, fadeIn: c.fadeIn ?? 0, fadeOut: c.fadeOut ?? 0 })),
      // Filters used to be timeline-wide; an older project's chain becomes
      // every clip's chain so nothing silently stops being applied.
      clips: p.clips.map((c) => ({
        ...c,
        filters: c.filters ?? (p.filters ?? []).map((f) => ({ ...f, id: newId() })),
      })),
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

/**
 * Pins every title card's text to its clip. Called after anything that moves
 * clips about: a card owned by a title has no independent timing, so its
 * start and end are simply wherever that clip now sits.
 */
export function syncTitleCards(clips: Clip[], cards: TextCard[]): TextCard[] {
  const place = new Map<string, { start: number; end: number }>();
  let at = 0;
  for (const c of clips) {
    const len = clipLength(c);
    if (c.fill) place.set(c.id, { start: at, end: at + len });
    at += len;
  }

  let changed = false;
  const next = cards.map((card) => {
    if (!card.ownerClipId) return card;
    const pos = place.get(card.ownerClipId);
    if (!pos) return card;
    if (card.start === pos.start && card.end === pos.end) return card;
    changed = true;
    const half = (pos.end - pos.start) / 2;
    return {
      ...card,
      start: pos.start,
      end: pos.end,
      // A fade longer than half the card would never reach full opacity.
      fadeIn: Math.min(card.fadeIn, half),
      fadeOut: Math.min(card.fadeOut, half),
    };
  });
  return changed ? next : cards;
}

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
