import { useRef } from "react";

interface Props {
  /** "col" sits between two columns and drags left/right; "row" drags up/down. */
  axis: "col" | "row";
  /** Current size in px of the panel this handle sizes. */
  value: number;
  min: number;
  max: number;
  /** True when dragging towards the start of the axis makes the panel bigger. */
  invert?: boolean;
  onChange: (px: number) => void;
  /** Double-click, or Escape mid-drag. */
  onReset: () => void;
  label: string;
}

/**
 * A drag handle between two panes. Pointer capture means the drag survives the
 * cursor leaving the 6px strip, which it always does.
 */
export function Splitter({ axis, value, min, max, invert, onChange, onReset, label }: Props) {
  const from = useRef<{ pos: number; size: number } | null>(null);

  const clamp = (px: number) => Math.round(Math.min(max, Math.max(min, px)));

  return (
    <div
      className={`splitter ${axis}`}
      role="separator"
      aria-label={label}
      aria-orientation={axis === "col" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onDoubleClick={onReset}
      onPointerDown={(e) => {
        e.preventDefault(); // no text selection in the panels either side
        from.current = { pos: axis === "col" ? e.clientX : e.clientY, size: value };
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add(axis === "col" ? "resizing-col" : "resizing-row");
      }}
      onPointerMove={(e) => {
        if (!from.current) return;
        const now = axis === "col" ? e.clientX : e.clientY;
        const delta = now - from.current.pos;
        onChange(clamp(from.current.size + (invert ? -delta : delta)));
      }}
      onPointerUp={(e) => {
        from.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing-col", "resizing-row");
      }}
      onKeyDown={(e) => {
        const grow = axis === "col" ? "ArrowRight" : "ArrowDown";
        const shrink = axis === "col" ? "ArrowLeft" : "ArrowUp";
        const step = e.shiftKey ? 40 : 8;
        if (e.key === grow || e.key === shrink) {
          e.preventDefault();
          const dir = (e.key === grow ? 1 : -1) * (invert ? -1 : 1);
          onChange(clamp(value + dir * step));
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onReset();
        }
      }}
    />
  );
}
