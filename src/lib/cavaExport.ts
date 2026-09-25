/**
 * Sidecar file for CAVA360VR.
 *
 * CAVA reads the cards as data and draws them as real objects in the sphere,
 * so they can be grabbed and moved. That is why this carries the text and the
 * style rather than a rendered image: Unity re-draws the card with TextMeshPro
 * and it stays crisp at any distance, and it can be edited later.
 *
 * Shape is deliberately flat and array-based so Unity's JsonUtility can read
 * it without any extra library.
 */
import type { StereoMode, TextCard } from "./types";

export interface CavaCard {
  id: string;
  text: string;
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
  /** Degrees. +yaw looks right, +pitch looks up, +roll rotates clockwise. */
  yaw: number;
  pitch: number;
  roll: number;
  widthDeg: number;
  fontSize: number;
  bold: boolean;
  color: string;
  bgColor: string;
  bgOpacity: number;
  padding: number;
  radius: number;
  align: string;
  shadow: boolean;
}

export interface CavaCardFile {
  version: 1;
  generator: string;
  /** File name of the video these cards belong to. */
  video: string;
  stereoMode: StereoMode;
  /** Canvas width the font size and padding were authored against. */
  designWidth: number;
  cards: CavaCard[];
}

export function buildCavaCardFile(
  cards: TextCard[],
  videoFileName: string,
  stereoMode: StereoMode,
  designWidth: number,
): CavaCardFile {
  return {
    version: 1,
    generator: "Bubblecut",
    video: videoFileName,
    stereoMode,
    designWidth,
    cards: cards
      .filter((c) => c.end > c.start && c.text.trim() !== "")
      .map((c) => ({
        id: c.id,
        text: c.text,
        start: round(c.start),
        end: round(c.end),
        fadeIn: round(c.fadeIn),
        fadeOut: round(c.fadeOut),
        yaw: round(c.yaw),
        pitch: round(c.pitch),
        roll: round(c.roll),
        widthDeg: round(c.widthDeg),
        fontSize: c.fontSize,
        bold: c.bold,
        color: c.color,
        bgColor: c.bgColor,
        bgOpacity: round(c.bgOpacity),
        padding: c.padding,
        radius: c.radius,
        align: c.align,
        shadow: c.shadow,
      })),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** CAVA looks for "<video file name>.cards.json" beside the video. */
export function cavaSidecarPath(videoOutputPath: string): string {
  return `${videoOutputPath}.cards.json`;
}
