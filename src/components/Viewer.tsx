import { useEffect, useRef } from "react";
import * as THREE from "three";
import { clipAt, clipLength, useStore } from "../lib/store";
import { cameraQuaternion, cardQuaternion, clipQuaternion } from "../lib/orientation";
import { cardOpacity, renderCard } from "../lib/cardRender";
import { FilterChain } from "../lib/filterChain";
import { mediaUrl } from "../lib/tauri";
import type { MediaInfo, TextCard } from "../lib/types";

/** Radius of the card plane; inside the 500-unit sky sphere. */
const CARD_R = 300;

interface CardMesh {
  card: TextCard;
  mesh: THREE.Mesh;
  texture: THREE.CanvasTexture;
}

/** Build a plane in the sphere showing the card's canvas. */
function makeCardMesh(card: TextCard): CardMesh {
  const canvas = renderCard(card);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const w = 2 * CARD_R * Math.tan((card.widthDeg * Math.PI) / 360);
  const h = w * (canvas.height / canvas.width);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  mesh.renderOrder = 10;
  return { card, mesh, texture };
}

/** Changing any of these means the canvas must be redrawn. */
const cardSignature = (c: TextCard) =>
  [c.text, c.fontSize, c.bold, c.color, c.bgColor, c.bgOpacity, c.padding, c.radius, c.align, c.shadow, c.widthDeg].join("\u0000");

/**
 * 360° preview: an inverted sphere textured with the <video> element.
 * Also owns playback — it is the only component that touches the video.
 */
export function Viewer() {
  const mountRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const threeRef = useRef<{
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    texture: THREE.VideoTexture;
    material: THREE.MeshBasicMaterial;
  } | null>(null);
  const loadedPath = useRef<string | null>(null);
  const chainRef = useRef<FilterChain | null>(null);
  const cardGroupRef = useRef<THREE.Group | null>(null);
  const cardMeshes = useRef<CardMesh[]>([]);
  const tmpQ = new THREE.Quaternion();
  const tmpClipQ = new THREE.Quaternion();
  const tmpCardQ = new THREE.Quaternion();

  // ---- three.js setup ----------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current!;
    const video = videoRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101216);
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1100);

    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map: texture });
    const cardGroup = new THREE.Group();
    scene.add(cardGroup);
    cardGroupRef.current = cardGroup;

    const geometry = new THREE.SphereGeometry(500, 96, 64);
    geometry.scale(-1, 1, 1);
    const sphere = new THREE.Mesh(geometry, material);
    sphere.rotation.y = -Math.PI / 2; // equirect centre → -Z
    scene.add(sphere);

    const chain = new FilterChain(renderer);
    chainRef.current = chain;
    threeRef.current = { renderer, camera, scene, texture, material };

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const { view, clips, playhead } = useStore.getState();
      const at = clipAt(clips, playhead);

      // Filters run on the equirectangular frame, before it is wrapped onto
      // the sphere, which is where the exporter applies them as well.
      const { filters, previewFilters, media } = useStore.getState();
      const active = previewFilters ? filters : [];
      chain.setChain(active);
      const m = at ? media[at.clip.mediaPath] : undefined;
      const filtered = active.length && m
        ? chain.render(texture, m.width, m.height, active)
        : texture;
      if (material.map !== filtered) {
        material.map = filtered;
        material.needsUpdate = true;
      }

      camera.quaternion.copy(cameraQuaternion(at?.clip ?? null, view));

      // Cards live in the exported video's frame, so they ride along with the
      // current clip's reorientation.
      const clipQ = at ? clipQuaternion(at.clip, tmpClipQ) : tmpClipQ.identity();
      const { selectedCardId, playing } = useStore.getState();
      for (const cm of cardMeshes.current) {
        const c = cm.card;
        const inRange = playhead >= c.start && playhead <= c.end;
        // While paused, the card being edited is drawn solid so it can be
        // positioned and styled even when the playhead sits inside a fade.
        // Playback always shows the real opacity.
        const editing = !playing && c.id === selectedCardId && inRange;
        const opacity = editing ? 1 : cardOpacity(c, playhead);
        cm.mesh.visible = opacity > 0.001;
        if (!cm.mesh.visible) continue;
        (cm.mesh.material as THREE.MeshBasicMaterial).opacity = opacity;
        tmpQ.copy(clipQ).multiply(cardQuaternion(c, tmpCardQ));
        cm.mesh.quaternion.copy(tmpQ);
        cm.mesh.position.set(0, 0, -CARD_R).applyQuaternion(tmpQ);
      }
      if (camera.fov !== view.fov) {
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      chain.dispose();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // ---- pointer look / wheel zoom ----------------------------------------
  useEffect(() => {
    const el = mountRef.current!;
    let dragging = false, lx = 0, ly = 0;
    const down = (e: PointerEvent) => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const { view, setView } = useStore.getState();
      const k = (view.fov / 90) * 0.15;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      setView({
        lon: view.lon - dx * k, // drag left → look right
        lat: Math.max(-89, Math.min(89, view.lat + dy * k)),
      });
    };
    const up = () => { dragging = false; };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, setView } = useStore.getState();
      setView({ fov: Math.max(30, Math.min(120, view.fov + e.deltaY * 0.05)) });
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }, []);

  // ---- playback engine --------------------------------------------------
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const cards = useStore((s) => s.cards);
  useStore((s) => s.selectedCardId); // re-render the loop's closure inputs
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);

  useEffect(() => {
    const group = cardGroupRef.current;
    if (!group) return;
    const existing = new Map(cardMeshes.current.map((cm) => [cm.card.id, cm]));
    const next: CardMesh[] = [];
    for (const card of cards) {
      const prev = existing.get(card.id);
      if (prev && cardSignature(prev.card) === cardSignature(card)) {
        prev.card = card; // geometry unchanged, just newer timing/angles
        next.push(prev);
        existing.delete(card.id);
        continue;
      }
      if (prev) {
        group.remove(prev.mesh);
        prev.mesh.geometry.dispose();
        prev.texture.dispose();
        existing.delete(card.id);
      }
      const cm = makeCardMesh(card);
      group.add(cm.mesh);
      next.push(cm);
    }
    for (const stale of existing.values()) {
      group.remove(stale.mesh);
      stale.mesh.geometry.dispose();
      stale.texture.dispose();
    }
    cardMeshes.current = next;
  }, [cards]);

  const applyStereo = (m: MediaInfo | undefined) => {
    const t = threeRef.current?.texture;
    if (!t) return;
    if (m?.stereoMode === "top-bottom") { t.repeat.set(1, 0.5); t.offset.set(0, 0.5); }
    else if (m?.stereoMode === "left-right") { t.repeat.set(0.5, 1); t.offset.set(0, 0); }
    else { t.repeat.set(1, 1); t.offset.set(0, 0); }
  };

  // Load the right file + seek whenever the playhead moves while paused.
  useEffect(() => {
    if (playing) return;
    const video = videoRef.current!;
    const at = clipAt(clips, playhead);
    if (!at) {
      video.removeAttribute("src");
      video.load();
      loadedPath.current = null;
      return;
    }
    const m = media[at.clip.mediaPath];
    if (!m) return;
    const seek = () => {
      if (Math.abs(video.currentTime - at.sourceTime) > 0.04) video.currentTime = at.sourceTime;
    };
    if (loadedPath.current !== m.path) {
      loadedPath.current = m.path;
      applyStereo(m);
      video.src = mediaUrl(m);
      video.addEventListener("loadedmetadata", seek, { once: true });
    } else {
      seek();
    }
  }, [clips, media, playhead, playing]);

  // Drive the playhead from the video while playing; hop between clips.
  useEffect(() => {
    const video = videoRef.current!;
    if (!playing) { video.pause(); return; }
    let raf = 0;
    let stopped = false;

    const startClip = (index: number) => {
      const { clips, media, setPlaying } = useStore.getState();
      const c = clips[index];
      if (!c) { setPlaying(false); return; }
      const m = media[c.mediaPath];
      if (!m) { setPlaying(false); return; }
      const go = () => {
        video.currentTime = c.inPoint;
        video.play().catch(() => setPlaying(false));
      };
      if (loadedPath.current !== m.path) {
        loadedPath.current = m.path;
        applyStereo(m);
        video.src = mediaUrl(m);
        video.addEventListener("loadedmetadata", go, { once: true });
      } else go();
    };

    const tick = () => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      const { clips, playhead, setPlayhead, setPlaying } = useStore.getState();
      const at = clipAt(clips, playhead);
      if (!at) { setPlaying(false); return; }
      const c = at.clip;
      const t = video.currentTime;
      if (t >= c.outPoint - 0.02 || video.ended) {
        if (at.index + 1 < clips.length) {
          setPlayhead(at.start + clipLength(c));
          startClip(at.index + 1);
        } else {
          setPlayhead(at.start + clipLength(c));
          setPlaying(false);
        }
        return;
      }
      if (video.paused) return; // still loading
      setPlayhead(at.start + Math.max(0, t - c.inPoint));
    };

    const { clips, playhead } = useStore.getState();
    const at = clipAt(clips, playhead);
    if (at) {
      if (loadedPath.current === at.clip.mediaPath) {
        if (Math.abs(video.currentTime - at.sourceTime) > 0.04) video.currentTime = at.sourceTime;
        video.play().catch(() => useStore.getState().setPlaying(false));
      } else startClip(at.index);
    }
    raf = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(raf); video.pause(); };
  }, [playing]);

  return (
    <div className="viewer" ref={mountRef}>
      <video ref={videoRef} playsInline muted={false} crossOrigin="anonymous" style={{ display: "none" }} />
      <div className="viewer-reticle" />
      {clips.length === 0 && (
        <div className="viewer-empty">
          <div>Import 360° footage to begin</div>
          <div className="hint">Equirectangular MP4/MOV · mono or top-bottom / side-by-side stereo</div>
        </div>
      )}
    </div>
  );
}
