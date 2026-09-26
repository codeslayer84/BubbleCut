export type StereoMode = "mono" | "top-bottom" | "left-right";

export type MediaKind = "video" | "audio";

export interface MediaInfo {
  /** Audio-only files sit in the same bin as the footage. */
  kind: MediaKind;
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string | null;
  audioChannels: number;
  hasAudio: boolean;
  fileSize: number;
  taggedSpherical: boolean;
  stereoMode: StereoMode;
  stereoGuessed: boolean;
  /** Only in browser dev mode: object URL for the file. */
  blobUrl?: string;
}

export interface Clip {
  id: string;
  mediaPath: string;
  inPoint: number;
  outPoint: number;
  /** Degrees; +yaw turns right, +pitch tilts up, +roll rotates clockwise. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Image filters applied to this clip only, in order. */
  filters: FilterInstance[];
  /**
   * A generated block of flat colour rather than footage — a title card. The
   * words come from an ordinary text card laid over it, so styling and timing
   * work the same as anywhere else.
   */
  fill?: { color: string };
}

export interface TextCard {
  id: string;
  text: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  /** Direction in the exported video, same convention as clip orientation. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Horizontal angular size of the card, in degrees. */
  widthDeg: number;
  /** Seconds to fade up at the start and down at the end. 0 = hard cut. */
  fadeIn: number;
  fadeOut: number;
  fontSize: number;
  bold: boolean;
  color: string;
  bgColor: string;
  bgOpacity: number;
  padding: number;
  radius: number;
  align: "left" | "center" | "right";
  shadow: boolean;
  /**
   * Set when the card belongs to a title clip. Such a card is pinned to that
   * clip's place on the timeline rather than living at a fixed time, so it
   * follows when the clip is lengthened, reordered, or pushed along by an
   * edit earlier in the timeline.
   */
  ownerClipId?: string;
}

/**
 * Music or narration on the audio lane.
 *
 * Unlike a video clip, which is positioned by the clips before it, this
 * carries its own `start` — the whole point is to run across cuts.
 */
export interface AudioTrack {
  id: string;
  mediaPath: string;
  /** Seconds along the timeline. */
  start: number;
  inPoint: number;
  outPoint: number;
  /** Linear, 1 = as recorded. */
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

/** One filter in the chain, with its parameter values. */
export interface FilterInstance {
  id: string;
  name: string;
  params: Record<string, number>;
}

export interface ExportSettings {
  output: string;
  encoder: string;
  width: number;
  height: number;
  fps: number;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  stereoMode: StereoMode;
  faststart: boolean;
  injectSpherical: boolean;
  /** Burn text cards into the pixels. Off = export them as a CAVA sidecar. */
  burnCards: boolean;
}

export interface Progress {
  percent: number;
  outTime: number;
  speed: string;
  fps: number;
  stage: string;
}

export interface ProbeVerification {
  sphericalMapping: boolean;
  projection: string | null;
  stereo3d: string | null;
}

export interface SphericalCheck {
  hasSv3d: boolean;
  hasSt3d: boolean;
  hasV1Uuid: boolean;
  stereoMode: string | null;
}

export interface InjectReport {
  tracksTagged: number;
  moovDeltaBytes: number;
  promotedCo64: boolean;
}

export interface ExportDone {
  output: string;
  fileSize: number;
  inject: InjectReport | null;
  boxes: SphericalCheck | null;
  ffprobe: ProbeVerification;
  command: string;
}

export interface ProjectFile {
  version: 1;
  media: MediaInfo[];
  clips: Clip[];
  cards?: TextCard[];
  filters?: FilterInstance[];
  exportSettings: Partial<ExportSettings>;
  /** Absent in files written before the audio lane existed. */
  audio?: AudioTrack[];
}
