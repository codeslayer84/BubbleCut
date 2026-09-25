/**
 * Saved filter chains.
 *
 * Presets are kept outside the project file, in the app's config folder, so a
 * look built for one recording can be reused on the next one — and so the
 * file can be copied to a colleague. In browser dev mode there is no config
 * folder, so they fall back to localStorage.
 */
import { isTauri } from "./tauri";

export interface PresetFilter {
  name: string;
  params: Record<string, number>;
}

export interface FilterPreset {
  name: string;
  filters: PresetFilter[];
}

const FILE_NAME = "filter-presets.json";
const STORAGE_KEY = "bubblecut.filterPresets";

async function presetFile(): Promise<string> {
  const { appConfigDir, join } = await import("@tauri-apps/api/path");
  return join(await appConfigDir(), FILE_NAME);
}

export async function loadPresets(): Promise<FilterPreset[]> {
  if (!isTauri) {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    } catch {
      return [];
    }
  }
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const path = await presetFile();
    if (!(await fs.exists(path))) return [];
    const parsed = JSON.parse(await fs.readTextFile(path));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    // A missing or unreadable preset file should never stop the editor.
    console.warn("Could not read filter presets:", e);
    return [];
  }
}

export async function savePresets(list: FilterPreset[]): Promise<void> {
  if (!isTauri) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    return;
  }
  const fs = await import("@tauri-apps/plugin-fs");
  const { appConfigDir } = await import("@tauri-apps/api/path");
  const dir = await appConfigDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Already there, which is the usual case.
  }
  await fs.writeTextFile(await presetFile(), JSON.stringify(list, null, 2));
}

/** Where the presets live, for showing the user. */
export async function presetLocation(): Promise<string> {
  return isTauri ? presetFile() : "this browser's local storage";
}
