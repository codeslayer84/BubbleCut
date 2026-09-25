/**
 * Cutting the timeline down to an exported selection.
 *
 * Rather than exporting everything and trimming the result, the clips
 * themselves are sliced to the range. ffmpeg then seeks straight to each
 * piece instead of decoding footage that will be thrown away, and the rest of
 * the export — per-clip filters, card overlays, the concat — carries on
 * working unchanged, because it only ever sees a shorter list of clips.
 */
import { clipLength } from "./store";
import type { Clip, TextCard } from "./types";

export interface Selection {
  start: number;
  end: number;
}

export interface SlicedTimeline {
  clips: Clip[];
  cards: TextCard[];
}

/**
 * Returns the clips and cards that fall inside `selection`, with their times
 * rebased so the selection starts at zero.
 */
export function sliceTimeline(
  clips: Clip[],
  cards: TextCard[],
  selection: Selection | null,
): SlicedTimeline {
  if (!selection) return { clips, cards };

  const { start, end } = selection;
  const out: Clip[] = [];
  let at = 0;

  for (const clip of clips) {
    const length = clipLength(clip);
    const clipStart = at;
    const clipEnd = at + length;
    at = clipEnd;

    // Overlap of this clip with the selection, on the timeline.
    const from = Math.max(clipStart, start);
    const to = Math.min(clipEnd, end);
    if (to - from <= 0.001) continue;

    // Convert that back into the source file's own timebase.
    out.push({
      ...clip,
      inPoint: clip.inPoint + (from - clipStart),
      outPoint: clip.inPoint + (to - clipStart),
      // Filters belong to the clip, so they come along untouched.
      filters: clip.filters.map((f) => ({ ...f })),
    });
  }

  const shifted = cards
    .filter((c) => c.end > start && c.start < end)
    .map((c) => ({
      ...c,
      start: Math.max(0, c.start - start),
      end: Math.min(end - start, c.end - start),
    }))
    .filter((c) => c.end - c.start > 0.001);

  return { clips: out, cards: shifted };
}

/** Length of what would be exported. */
export function selectionDuration(
  clips: Clip[],
  selection: Selection | null,
): number {
  const total = clips.reduce((n, c) => n + clipLength(c), 0);
  if (!selection) return total;
  return Math.max(0, Math.min(selection.end, total) - Math.max(0, selection.start));
}
