/**
 * Panel sizes.
 *
 * Window furniture rather than project data, so it lives in localStorage and
 * follows the machine, not the edit. `timeline: null` means "as tall as its
 * contents need" — what it always did before it could be dragged.
 */

export interface PanelSizes {
  left: number;
  right: number;
  /** null = size to contents. */
  timeline: number | null;
}

export const PANEL_DEFAULTS: PanelSizes = { left: 240, right: 340, timeline: null };

export const PANEL_LIMITS = {
  left: { min: 150, max: 520 },
  right: { min: 260, max: 680 },
  timeline: { min: 120, max: 560 },
} as const;

/** Below this the viewer stops being worth looking at. */
const MIN_CENTER = 320;

const KEY = "bubblecut.panels";

export function clampPanel(which: keyof PanelSizes, px: number): number {
  const { min, max } = PANEL_LIMITS[which];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/**
 * Narrow the sides until the viewer has room. A window can be dragged smaller
 * than the panels that were saved in it, so this runs on every render rather
 * than only when a splitter moves.
 */
export function fitToWidth(p: PanelSizes, windowWidth: number): PanelSizes {
  let over = p.left + p.right + MIN_CENTER - windowWidth;
  if (over <= 0) return p;
  let { left, right } = p;
  // Off the wider side first, so an oversized panel gives up its space before
  // a small one does.
  for (let i = 0; i < 2 && over > 0; i++) {
    const big = left >= right ? "left" : "right";
    const cur = big === "left" ? left : right;
    const next = Math.max(PANEL_LIMITS[big].min, cur - over);
    over -= cur - next;
    if (big === "left") left = next; else right = next;
  }
  return { ...p, left, right };
}

export function loadPanels(): PanelSizes {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return PANEL_DEFAULTS;
    const v = JSON.parse(raw) as Partial<PanelSizes>;
    return {
      left: clampPanel("left", Number(v.left) || PANEL_DEFAULTS.left),
      right: clampPanel("right", Number(v.right) || PANEL_DEFAULTS.right),
      timeline: typeof v.timeline === "number" ? clampPanel("timeline", v.timeline) : null,
    };
  } catch {
    return PANEL_DEFAULTS; // private window, or someone hand-edited it
  }
}

export function savePanels(p: PanelSizes): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* not worth telling anyone about */
  }
}
