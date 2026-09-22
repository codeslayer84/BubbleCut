/**
 * Thin wrappers around the Rust commands. Everything degrades gracefully when
 * running as a plain Vite page (no Tauri) so the UI can be developed in a
 * browser with local files.
 */
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cardPngBase64 } from "./cardRender";
import type {
  Clip,
  ExportDone,
  ExportSettings,
  MediaInfo,
  Progress,
  SphericalCheck,
  StereoMode,
  TextCard,
} from "./types";

export const isTauri = "__TAURI_INTERNALS__" in window;

export interface FfmpegInfo {
  version: string;
  encoders: string[];
  path: string;
  archs: string[];
  hostArch: string;
  /** ffmpeg can only run translated, so hardware encoding is unavailable. */
  emulated: boolean;
}

export const ffmpegInfo = () => invoke<FfmpegInfo>("ffmpeg_info");
export const probeMedia = (path: string) => invoke<MediaInfo>("probe_media", { path });
export const checkSpherical = (path: string) =>
  invoke<SphericalCheck>("check_spherical", { path });
export const cancelExport = () => invoke<boolean>("cancel_export");

export interface TagResult {
  inject: { tracksTagged: number; moovDeltaBytes: number; promotedCo64: boolean };
  boxes: SphericalCheck;
  ffprobe: { sphericalMapping: boolean; projection: string | null; stereo3d: string | null };
}
export const tagSpherical = (input: string, output: string, stereo: StereoMode) =>
  invoke<TagResult>("tag_spherical", { input, output, stereo });

export function startExport(
  clips: Clip[],
  media: Record<string, MediaInfo>,
  cards: TextCard[],
  settings: ExportSettings,
) {
  const exportClips = clips.map((c) => {
    const m = media[c.mediaPath];
    return {
      path: c.mediaPath,
      inPoint: c.inPoint,
      outPoint: c.outPoint,
      yaw: c.yaw,
      pitch: c.pitch,
      roll: c.roll,
      hasAudio: m?.hasAudio ?? false,
      stereoMode: m?.stereoMode ?? "mono",
      width: m?.width ?? 0,
      height: m?.height ?? 0,
      fps: m?.fps ?? 0,
    };
  });
  // Cards are rasterised here so the export matches the preview exactly.
  // With burnCards off they stay out of the video and travel as a sidecar.
  const exportCards = (settings.burnCards ? cards : [])
    .filter((c) => c.end > c.start && c.text.trim() !== "")
    .map((c) => {
      const png = cardPngBase64(c);
      return {
        pngBase64: png.base64,
        pngWidth: png.width,
        pngHeight: png.height,
        start: c.start,
        end: c.end,
        yaw: c.yaw,
        pitch: c.pitch,
        roll: c.roll,
        widthDeg: c.widthDeg,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
      };
    });
  return invoke<void>("start_export", { clips: exportClips, cards: exportCards, settings });
}

export function onExportEvents(handlers: {
  progress: (p: Progress) => void;
  done: (d: ExportDone) => void;
  error: (msg: string) => void;
}): () => void {
  const unlisteners: Promise<UnlistenFn>[] = [
    listen<Progress>("export:progress", (e) => handlers.progress(e.payload)),
    listen<ExportDone>("export:done", (e) => handlers.done(e.payload)),
    listen<string>("export:error", (e) => handlers.error(e.payload)),
  ];
  return () => {
    unlisteners.forEach((p) => p.then((u) => u()));
  };
}

/** URL the <video> element can load for a media item. */
export function mediaUrl(m: MediaInfo): string {
  if (m.blobUrl) return m.blobUrl;
  return convertFileSrc(m.path);
}

/** Open-file dialog (Tauri) — returns absolute paths. */
export async function pickVideoFiles(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: true,
    filters: [{ name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "insv"] }],
  });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

export async function pickSavePath(defaultName: string, ext = "mp4"): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
}

export async function pickOpenPath(ext: string): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  return typeof res === "string" ? res : null;
}

export async function revealInFinder(path: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function readTextFile(path: string) {
  const fs = await import("@tauri-apps/plugin-fs");
  return fs.readTextFile(path);
}
export async function writeTextFile(path: string, text: string) {
  const fs = await import("@tauri-apps/plugin-fs");
  return fs.writeTextFile(path, text);
}

/** Browser-only fallback: probe with a <video> element. */
export function probeInBrowser(file: File): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const ar = v.videoWidth / v.videoHeight;
      resolve({
        path: file.name,
        name: file.name,
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
        fps: 30,
        videoCodec: "?",
        audioCodec: null,
        audioChannels: 2,
        hasAudio: true,
        fileSize: file.size,
        taggedSpherical: false,
        stereoMode: Math.abs(ar - 1) < 0.15 ? "top-bottom" : Math.abs(ar - 4) < 0.3 ? "left-right" : "mono",
        stereoGuessed: true,
        blobUrl: url,
      });
    };
    v.onerror = () => reject(new Error("cannot decode " + file.name));
    v.src = url;
  });
}
