/**
 * Cutting the timeline down to the parts chosen for export.
 *
 * Rather than exporting everything and trimming the result, the clips
 * themselves are sliced to each range. ffmpeg then seeks straight to each
 * piece instead of decoding footage that will be thrown away, and the rest of
 * the export — per-clip filters, card overlays, the concat — carries on
 * working unchanged, because it only ever sees a shorter list of clips.
 */
import { clipLength } from "./store";
import type { Clip, TextCard } from "./types";

export interface Range {
  start: number;
  end: number;
}

export interface SlicedTimeline {
  clips: Clip[];
  cards: TextCard[];
}

/**
 * Sorted, with overlaps merged. Two ranges that touch would otherwise export
 * the overlapping footage twice.
 */
export function normalizeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges]
    .map((r) => ({ start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) }))
    .filter((r) => r.end - r.start > 0.001)
    .sort((a, b) => a.start - b.start);

  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.001) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** The clips lying inside one range, with their source times adjusted. */
function sliceOne(clips: Clip[], range: Range): Clip[] {
  const out: Clip[] = [];
  let at = 0;
  for (const clip of clips) {
    const length = clipLength(clip);
    const clipStart = at;
    const clipEnd = at + length;
    at = clipEnd;

    const from = Math.max(clipStart, range.start);
    const to = Math.min(clipEnd, range.end);
    if (to - from <= 0.001) continue;

    out.push({
      ...clip,
      inPoint: clip.inPoint + (from - clipStart),
      outPoint: clip.inPoint + (to - clipStart),
      filters: clip.filters.map((f) => ({ ...f })),
    });
  }
  return out;
}

/**
 * The clips and cards inside `ranges`, joined in timeline order with their
 * times rebased so the export starts at zero. No ranges means the whole
 * timeline, untouched.
 */
export function sliceTimeline(
  clips: Clip[],
  cards: TextCard[],
  ranges: Range[],
): SlicedTimeline {
  const merged = normalizeRanges(ranges);
  if (merged.length === 0) return { clips, cards };

  const outClips: Clip[] = [];
  const outCards: TextCard[] = [];
  let written = 0; // how far into the exported timeline we are

  for (const range of merged) {
    // A clip cut short cannot keep a fade longer than what is left of it.
    const piece = sliceOne(clips, range).map((c) => {
      const half = clipLength(c) / 2;
      if ((c.audioFadeIn ?? 0) <= half && (c.audioFadeOut ?? 0) <= half) return c;
      return {
        ...c,
        audioFadeIn: Math.min(c.audioFadeIn ?? 0, half),
        audioFadeOut: Math.min(c.audioFadeOut ?? 0, half),
      };
    });
    outClips.push(...piece);

    // Cards move to where their range landed in the finished export.
    const shift = written - range.start;
    for (const c of cards) {
      if (c.end <= range.start || c.start >= range.end) continue;
      const start = Math.max(c.start, range.start) + shift;
      const end = Math.min(c.end, range.end) + shift;
      if (end - start > 0.001) outCards.push({ ...c, start, end });
    }

    written += piece.reduce((n, c) => n + clipLength(c), 0);
  }

  return { clips: outClips, cards: outCards };
}

/** Length of what would be exported. */
export function selectionDuration(clips: Clip[], ranges: Range[]): number {
  const total = clips.reduce((n, c) => n + clipLength(c), 0);
  const merged = normalizeRanges(ranges);
  if (merged.length === 0) return total;
  return merged.reduce(
    (n, r) => n + Math.max(0, Math.min(r.end, total) - Math.max(0, r.start)),
    0,
  );
}
