/**
 * Runs the preview filter chain over the video frame.
 *
 * The filters are applied to the equirectangular frame before it is mapped
 * onto the sphere, which is where the exporter applies them too, so the
 * preview and the export see the same input.
 */
import * as THREE from "three";
import { filterByName } from "./filterShaders";
import type { FilterInstance } from "./types";

const VERTEX = `
  varying vec2 vTexCoord;
  void main() {
    vTexCoord = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

function fragmentFor(name: string, params: Record<string, number>): string | null {
  const def = filterByName(name);
  if (!def) return null;
  const radius = def.recompileOn ? Math.round(params[def.recompileOn] ?? 3) : 0;
  return `
    precision highp float;
    varying vec2 vTexCoord;
    uniform sampler2D uSampler;
    uniform float uInvWidth;
    uniform float uInvHeight;
    uniform float p0; uniform float p1; uniform float p2; uniform float p3;
    uniform float p4; uniform float p5; uniform float p6; uniform float p7;
    #define RADIUS ${radius}
    ${def.fragment}`;
}

interface Pass {
  name: string;
  signature: string;
  material: THREE.ShaderMaterial;
}

export class FilterChain {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private targets: THREE.WebGLRenderTarget[] = [];
  private passes: Pass[] = [];
  private width = 0;
  private height = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    this.scene.add(this.quad);
  }

  /** Rebuilds only the passes whose shader actually changed. */
  setChain(chain: FilterInstance[]) {
    const next: Pass[] = [];
    for (const item of chain) {
      const def = filterByName(item.name);
      if (!def) continue;
      const baked = def.recompileOn ? item.params[def.recompileOn] : 0;
      const signature = `${item.name}:${baked}`;
      const existing = this.passes.find((p) => p.signature === signature && !next.includes(p));
      if (existing) {
        next.push(existing);
      } else {
        const fragment = fragmentFor(item.name, item.params);
        if (!fragment) continue;
        next.push({
          name: item.name,
          signature,
          material: new THREE.ShaderMaterial({
            vertexShader: VERTEX,
            fragmentShader: fragment,
            uniforms: {
              uSampler: { value: null },
              uInvWidth: { value: 1 },
              uInvHeight: { value: 1 },
              p0: { value: 0 }, p1: { value: 0 }, p2: { value: 0 }, p3: { value: 0 },
              p4: { value: 0 }, p5: { value: 0 }, p6: { value: 0 }, p7: { value: 0 },
            },
          }),
        });
      }
    }
    for (const old of this.passes) {
      if (!next.includes(old)) old.material.dispose();
    }
    this.passes = next;
  }

  private ensureTargets(width: number, height: number) {
    if (this.width === width && this.height === height && this.targets.length) return;
    this.targets.forEach((t) => t.dispose());
    this.width = width;
    this.height = height;
    this.targets = [0, 1].map(() =>
      new THREE.WebGLRenderTarget(width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
      }),
    );
  }

  /** Returns the filtered texture, or the input when the chain is empty. */
  render(
    input: THREE.Texture,
    width: number,
    height: number,
    chain: FilterInstance[],
  ): THREE.Texture {
    if (!this.passes.length || width <= 0 || height <= 0) return input;
    this.ensureTargets(width, height);

    const previousTarget = this.renderer.getRenderTarget();
    let source: THREE.Texture = input;
    let index = 0;
    this.passes.forEach((pass, i) => {
      const item = chain[i];
      const def = filterByName(pass.name);
      const u = pass.material.uniforms;
      u.uSampler.value = source;
      u.uInvWidth.value = 1 / width;
      u.uInvHeight.value = 1 / height;
      def?.params.forEach((p, slot) => {
        const key = `p${slot}` as keyof typeof u;
        if (u[key]) u[key].value = item?.params[p.key] ?? p.default;
      });
      this.quad.material = pass.material;
      const target = this.targets[index];
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
      source = target.texture;
      index = 1 - index;
    });
    this.renderer.setRenderTarget(previousTarget);
    return source;
  }

  dispose() {
    this.passes.forEach((p) => p.material.dispose());
    this.targets.forEach((t) => t.dispose());
    this.quad.geometry.dispose();
  }
}
