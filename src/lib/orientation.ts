/**
 * Orientation math shared by the preview and the "set as front" tool.
 *
 * Conventions (verified against ffmpeg's v360 filter):
 *   +yaw   → view turns right   → rotation about +Y by -yaw
 *   +pitch → view tilts up      → rotation about +X by +pitch
 *   +roll  → camera rolls CW    → rotation about +Z by -roll
 * Camera looks down -Z, +X is right, +Y is up. The equirect centre maps to -Z.
 */
import * as THREE from "three";
import type { Clip } from "./types";
import type { View } from "./store";

const D2R = Math.PI / 180;
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

export function clipQuaternion(c: Pick<Clip, "yaw" | "pitch" | "roll">, out = new THREE.Quaternion()) {
  const qy = new THREE.Quaternion().setFromAxisAngle(Y, -c.yaw * D2R);
  const qp = new THREE.Quaternion().setFromAxisAngle(X, c.pitch * D2R);
  const qr = new THREE.Quaternion().setFromAxisAngle(Z, -c.roll * D2R);
  return out.copy(qy).multiply(qp).multiply(qr);
}

export function viewQuaternion(v: Pick<View, "lon" | "lat">, out = new THREE.Quaternion()) {
  const qy = new THREE.Quaternion().setFromAxisAngle(Y, -v.lon * D2R);
  const qp = new THREE.Quaternion().setFromAxisAngle(X, v.lat * D2R);
  return out.copy(qy).multiply(qp);
}

/** Full camera orientation = clip reorientation ∘ user look direction. */
export function cameraQuaternion(c: Pick<Clip, "yaw" | "pitch" | "roll"> | null, v: View) {
  const q = viewQuaternion(v);
  if (!c) return q;
  return clipQuaternion(c).multiply(q);
}

/**
 * Yaw/pitch that would put the direction currently in the centre of the
 * preview at the centre of the exported frame.
 */
export function frontFromView(c: Clip, v: View): { yaw: number; pitch: number; roll: number } {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuaternion(c, v));
  const yaw = Math.atan2(fwd.x, -fwd.z) / D2R;
  const pitch = Math.asin(Math.min(1, Math.max(-1, fwd.y))) / D2R;
  return { yaw: round1(yaw), pitch: round1(pitch), roll: 0 };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
