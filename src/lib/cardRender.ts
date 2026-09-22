/**
 * Renders a text card to a canvas.
 *
 * This is the single source of truth for what a card looks like: the 3D
 * preview uses the canvas as a texture, and the exporter sends the very same
 * canvas to ffmpeg as a PNG. If it looks right in the viewport it is what
 * gets burned into the video.
 */
import type { TextCard } from "./types";

/** Widest a card may get before its text wraps, in canvas pixels. */
export const CARD_MAX_W = 1600;

const FONT_STACK = `-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif`;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) { out.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function renderCard(card: TextCard): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const pad = card.padding;
  const font = `${card.bold ? "700" : "400"} ${card.fontSize}px ${FONT_STACK}`;

  // Measure first, then shrink-wrap the canvas to the text so a short caption
  // gets a snug box instead of a wide, mostly empty one.
  ctx.font = font;
  const lines = wrap(ctx, card.text || " ", CARD_MAX_W - pad * 2);
  const lineHeight = Math.round(card.fontSize * 1.25);
  const textHeight = lines.length * lineHeight;
  const textWidth = Math.max(1, ...lines.map((l) => ctx.measureText(l).width));

  canvas.width = Math.max(1, Math.round(Math.min(CARD_MAX_W, textWidth + pad * 2)));
  canvas.height = Math.max(1, Math.round(textHeight + pad * 2));

  // Re-set after resize (resizing clears the context state).
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (card.bgOpacity > 0) {
    ctx.fillStyle = withAlpha(card.bgColor, card.bgOpacity);
    const r = Math.min(card.radius, canvas.width / 2, canvas.height / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(0, 0, canvas.width, canvas.height, r);
    else ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.fill();
  }

  if (card.shadow) {
    // Keeps light text readable over a bright sky without a background box.
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = Math.round(card.fontSize * 0.25);
    ctx.shadowOffsetY = Math.round(card.fontSize * 0.04);
  }
  ctx.fillStyle = card.color;
  ctx.textAlign = card.align;
  const x = card.align === "left" ? pad : card.align === "right" ? canvas.width - pad : canvas.width / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, pad + i * lineHeight));

  return canvas;
}

/**
 * Card opacity at a given timeline time, 0 outside its range.
 * The exporter reproduces this with ffmpeg's `fade` filter.
 */
export function cardOpacity(card: TextCard, t: number): number {
  if (t < card.start || t > card.end) return 0;
  const up = card.fadeIn > 0 ? Math.min(1, (t - card.start) / card.fadeIn) : 1;
  const down = card.fadeOut > 0 ? Math.min(1, (card.end - t) / card.fadeOut) : 1;
  return Math.max(0, Math.min(1, up * down));
}

/** Vertical field of view (degrees) for a rectilinear card of this aspect. */
export function verticalFov(horizontalFovDeg: number, width: number, height: number): number {
  const h = (horizontalFovDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(h / 2) * (height / width)) * 180) / Math.PI;
}

/** PNG bytes, base64 encoded, for handing to ffmpeg. */
export function cardPngBase64(card: TextCard): { base64: string; width: number; height: number } {
  const canvas = renderCard(card);
  const url = canvas.toDataURL("image/png");
  return { base64: url.slice(url.indexOf(",") + 1), width: canvas.width, height: canvas.height };
}
