export type StereoMode = "mono" | "top-bottom" | "left-right";

export interface MediaInfo {
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
  exportSettings: Partial<ExportSettings>;
}
