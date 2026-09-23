/**
 * The preview copies of 360mash's filters.
 *
 * These are the original GLSL fragment shaders, used unchanged: the preview is
 * WebGL just as 360mash is, so there is nothing to translate. The export runs
 * ports of the same shaders through wgpu, and the two are kept in step by
 * sharing the parameter names and defaults defined here.
 */

export interface FilterParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface FilterDef {
  name: string;
  params: FilterParam[];
  /** Body of the fragment shader, sampling uSampler at vTexCoord. */
  fragment: string;
  /** Rebuild the shader when this parameter changes (baked in, not a uniform). */
  recompileOn?: string;
}

// three.js injects its own common chunk, which already defines luminance().
// Redefining it fails to compile, so everything here carries a prefix.
const LUMINANCE = `
  float mashLuminance(vec3 c) {
    vec3 lin = sqrt(c);
    return lin.r * 0.2126 + lin.g * 0.7152 + lin.b * 0.0722;
  }
  float mashEdgeDelta(vec2 start, vec2 delta) {
    vec2 perp = vec2(delta.y, -delta.x);
    float before = 0.0;
    for (int i = -1; i <= 1; i++) {
      before += mashLuminance(texture2D(uSampler, start - delta + float(i) * perp).rgb);
    }
    float after = 0.0;
    for (int i = -1; i <= 1; i++) {
      after += mashLuminance(texture2D(uSampler, start + delta + float(i) * perp).rgb);
    }
    return (after - before) * 0.3333;
  }`;

export const FILTERS: FilterDef[] = [
  {
    name: "Grayscale",
    params: [],
    fragment: `
      void main() {
        vec4 c = texture2D(uSampler, vTexCoord);
        gl_FragColor = vec4(vec3(0.333) * (c.r + c.g + c.b), 1.0);
      }`,
  },
  {
    name: "Pixelate",
    params: [{ key: "blockSize", label: "Block size", min: 2, max: 128, step: 1, default: 16 }],
    fragment: `
      void main() {
        vec2 texelSize = vec2(uInvWidth, uInvHeight);
        vec2 pixelCoord = vTexCoord / texelSize;
        vec2 blockCoord = (floor(pixelCoord / p0) + 0.5) * p0;
        gl_FragColor = texture2D(uSampler, blockCoord * texelSize);
      }`,
  },
  {
    name: "News Print",
    params: [
      { key: "scale", label: "Scale", min: 0, max: 2, step: 0.05, default: 0.3 },
      { key: "angle", label: "Angle", min: 0, max: 6.28, step: 0.05, default: 2.0 },
      { key: "brightness", label: "Brightness", min: 1, max: 20, step: 0.5, default: 9.5 },
    ],
    fragment: `
      float dotScreen(float scale) {
        vec2 p = vec2(0.7, 0.7) * vTexCoord / vec2(uInvWidth, uInvHeight);
        vec2 q = mat2(cos(p1), -sin(p1), sin(p1), cos(p1)) * p * scale;
        return (sin(q.x) * sin(q.y)) * 5.0;
      }
      void main() {
        vec4 tex = texture2D(uSampler, vTexCoord);
        float scale = 0.3 + 0.8 * p0;
        gl_FragColor = vec4(tex.rgb * p2 - vec3(5.0 + dotScreen(scale)), 1.0);
      }`,
  },
  {
    name: "Charcoal",
    params: [
      { key: "intensity", label: "Intensity", min: 0, max: 4, step: 0.05, default: 1.0 },
      { key: "inverse", label: "Inverse", min: 0, max: 1, step: 1, default: 0 },
    ],
    fragment: `
      ${LUMINANCE}
      float mashEdgeStrength(vec2 coords) {
        float aspect = uInvHeight / uInvWidth;
        float xStep = 0.00162;
        float yStep = xStep * aspect;
        float hor = mashEdgeDelta(coords, vec2(xStep, 0.0));
        float ver = mashEdgeDelta(coords, vec2(0.0, yStep));
        return (abs(hor) + abs(ver)) * 0.2;
      }
      void main() {
        vec4 tex = texture2D(uSampler, vTexCoord);
        vec3 outRgb = (tex.r + tex.g + tex.b) * vec3(0.333);
        float edge = mashEdgeStrength(vTexCoord) * p0 * 5.5;
        float x = p1 == 1.0 ? 0.04 : 0.11;
        outRgb *= 1.0 - smoothstep(x, 0.1, edge);
        if (outRgb != vec3(0.0)) { outRgb = vec3(1.0); }
        gl_FragColor = vec4(outRgb, 1.0);
      }`,
  },
  {
    name: "Cartoon",
    params: [
      { key: "edgeIntensity", label: "Edges", min: 0, max: 4, step: 0.05, default: 1.0 },
      { key: "colorCount", label: "Colours", min: 1, max: 20, step: 1, default: 6.0 },
      { key: "colorBright", label: "Brightness steps", min: 1, max: 20, step: 1, default: 10.0 },
    ],
    fragment: `
      ${LUMINANCE}
      vec3 displayToLinear(vec3 c) { return pow(c, vec3(0.455)); }
      vec3 linearToDisplay(vec3 c) { return pow(c, vec3(2.2)); }
      vec3 toHsv(vec3 color) {
        color = displayToLinear(color);
        float V = max(max(color.r, color.g), color.b);
        float Xmin = min(min(color.r, color.g), color.b);
        float C = V - Xmin;
        float H;
        if (C == 0.0) { H = 0.0; }
        else if (V == color.r) { H = 60.0 * (0.0 + (color.g - color.b) / C); }
        else if (V == color.g) { H = 60.0 * (2.0 + (color.b - color.r) / C); }
        else { H = 60.0 * (4.0 + (color.r - color.g) / C); }
        float S = V == 0.0 ? 0.0 : C / V;
        return vec3(H, S, V);
      }
      float fromHsvHelper(float n, vec3 hsv) {
        float k = mod(n + hsv.x / 60.0, 6.0);
        return hsv.z - hsv.z * hsv.y * max(0.0, min(min(k, 4.0 - k), 1.0));
      }
      vec3 fromHsv(vec3 hsv) {
        return linearToDisplay(vec3(fromHsvHelper(5.0, hsv), fromHsvHelper(3.0, hsv), fromHsvHelper(1.0, hsv)));
      }
      float quantize(float v, float levels) { return floor(v * levels) / levels; }
      float mashEdgeStrength(vec2 coords) {
        float hor = mashEdgeDelta(coords, vec2(uInvWidth * 1.75, 0.0));
        float ver = mashEdgeDelta(coords, vec2(0.0, uInvHeight * 1.75));
        return (abs(hor) + abs(ver)) * 0.5;
      }
      void main() {
        vec4 c = texture2D(uSampler, vTexCoord);
        vec3 hsv = toHsv(c.rgb);
        hsv.y = quantize(hsv.y, p1 * 1.33);
        hsv.z = quantize(hsv.z, p2);
        vec3 outRgb = fromHsv(hsv);
        outRgb *= 1.0 - smoothstep(0.04, 0.1, mashEdgeStrength(vTexCoord) * p0);
        gl_FragColor = vec4(outRgb, 1.0);
      }`,
  },
  {
    name: "Monet",
    recompileOn: "radius",
    params: [{ key: "radius", label: "Radius", min: 1, max: 12, step: 1, default: 3 }],
    fragment: `
      void main() {
        vec2 texel = vec2(uInvWidth, uInvHeight);
        vec3 sum0 = vec3(0.0); vec3 sq0 = vec3(0.0); float n0 = 0.0;
        vec3 sum1 = vec3(0.0); vec3 sq1 = vec3(0.0); float n1 = 0.0;
        vec3 sum2 = vec3(0.0); vec3 sq2 = vec3(0.0); float n2 = 0.0;
        vec3 sum3 = vec3(0.0); vec3 sq3 = vec3(0.0); float n3 = 0.0;
        for (int i = 0; i <= RADIUS; i++) {
          for (int j = 0; j <= RADIUS; j++) {
            vec2 off = vec2(float(i), float(j)) * texel;
            vec3 a = texture2D(uSampler, vTexCoord + vec2( off.x,  off.y)).rgb; sum0 += a; sq0 += a*a; n0 += 1.0;
            vec3 b = texture2D(uSampler, vTexCoord + vec2(-off.x,  off.y)).rgb; sum1 += b; sq1 += b*b; n1 += 1.0;
            vec3 c = texture2D(uSampler, vTexCoord + vec2( off.x, -off.y)).rgb; sum2 += c; sq2 += c*c; n2 += 1.0;
            vec3 d = texture2D(uSampler, vTexCoord + vec2(-off.x, -off.y)).rgb; sum3 += d; sq3 += d*d; n3 += 1.0;
          }
        }
        vec3 m0 = sum0/n0; vec3 v0v = sq0/n0 - m0*m0; float v0 = v0v.r+v0v.g+v0v.b;
        vec3 m1 = sum1/n1; vec3 v1v = sq1/n1 - m1*m1; float v1 = v1v.r+v1v.g+v1v.b;
        vec3 m2 = sum2/n2; vec3 v2v = sq2/n2 - m2*m2; float v2 = v2v.r+v2v.g+v2v.b;
        vec3 m3 = sum3/n3; vec3 v3v = sq3/n3 - m3*m3; float v3 = v3v.r+v3v.g+v3v.b;
        vec3 outColor = m0; float minVar = v0;
        if (v1 < minVar) { minVar = v1; outColor = m1; }
        if (v2 < minVar) { minVar = v2; outColor = m2; }
        if (v3 < minVar) { minVar = v3; outColor = m3; }
        gl_FragColor = vec4(outColor, 1.0);
      }`,
  },
  {
    name: "Van Gogh",
    recompileOn: "strokeLength",
    params: [
      { key: "strokeLength", label: "Stroke length", min: 2, max: 30, step: 1, default: 14 },
      { key: "strokeDetail", label: "Bristle detail", min: 0.2, max: 4, step: 0.05, default: 1 },
      { key: "impasto", label: "Impasto", min: 0, max: 3, step: 0.05, default: 1 },
      { key: "saturation", label: "Saturation", min: 0, max: 2.5, step: 0.05, default: 1.35 },
    ],
    // Strokes follow contours rather than gradients, which is what gives the
    // swirls; noise smeared along them makes the bristle marks, and sampling
    // that noise again just across the stroke lights the ridges of paint.
    fragment: `
      ${LUMINANCE}
      float vgHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vgNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f0 = fract(p);
        vec2 f = f0 * f0 * (3.0 - 2.0 * f0);
        float a = vgHash(i);
        float b = vgHash(i + vec2(1.0, 0.0));
        float c = vgHash(i + vec2(0.0, 1.0));
        float d = vgHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      vec2 vgGradient(vec2 uv, vec2 texel) {
        float st = 2.0;
        float gx = mashLuminance(texture2D(uSampler, uv + vec2(texel.x * st, 0.0)).rgb)
                 - mashLuminance(texture2D(uSampler, uv - vec2(texel.x * st, 0.0)).rgb);
        float gy = mashLuminance(texture2D(uSampler, uv + vec2(0.0, texel.y * st)).rgb)
                 - mashLuminance(texture2D(uSampler, uv - vec2(0.0, texel.y * st)).rgb);
        return vec2(gx, gy);
      }
      // Averaging the structure tensor rather than raw gradients, so that a
      // direction and its opposite do not cancel each other out.
      vec2 vgFlow(vec2 uv, vec2 texel) {
        float jxx = 0.0; float jxy = 0.0; float jyy = 0.0;
        for (int i = -1; i <= 1; i++) {
          for (int j = -1; j <= 1; j++) {
            vec2 at = uv + vec2(float(i), float(j)) * texel * 3.0;
            vec2 g = vgGradient(at, texel);
            jxx += g.x * g.x; jxy += g.x * g.y; jyy += g.y * g.y;
          }
        }
        if (jxx + jyy < 1e-5) {
          float a = vgNoise(uv * 3.0) * 6.2831853;
          return vec2(cos(a), sin(a));
        }
        float diff = jxx - jyy;
        float root = sqrt(diff * diff + 4.0 * jxy * jxy);
        float major = 0.5 * (jxx + jyy + root);
        vec2 across = normalize(vec2(jxy, major - jxx) + vec2(1e-8, 0.0));
        return vec2(-across.y, across.x);
      }
      float vgStrokeNoise(vec2 uv, vec2 dir, vec2 texel, float freq) {
        float total = 0.0; float count = 0.0;
        for (int i = -RADIUS; i <= RADIUS; i++) {
          vec2 p = uv + dir * texel * float(i) * 1.5;
          total += vgNoise(p * freq);
          count += 1.0;
        }
        return total / count;
      }
      void main() {
        vec2 texel = vec2(uInvWidth, uInvHeight);
        vec2 dir = vgFlow(vTexCoord, texel);
        vec2 perp = vec2(-dir.y, dir.x);

        vec3 col = vec3(0.0); float wsum = 0.0;
        for (int i = -RADIUS; i <= RADIUS; i++) {
          float t = float(i);
          vec2 p = vTexCoord + dir * texel * t * 1.5;
          float w = 1.0 - abs(t) / float(RADIUS + 1);
          col += texture2D(uSampler, p).rgb * w;
          wsum += w;
        }
        col /= wsum;

        float freq = 140.0 * max(p1, 0.01);
        float lic = vgStrokeNoise(vTexCoord, dir, texel, freq);
        float licSide = vgStrokeNoise(vTexCoord + perp * texel * 2.0, dir, texel, freq);
        float slope = licSide - lic;

        col *= 0.88 + 0.5 * (lic - 0.5);
        col += vec3(slope * p2 * 4.0);
        float grey = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(grey), col, p3);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`,
  },
  {
    name: "Painting",
    params: [
      { key: "radius", label: "Radius", min: 1, max: 30, step: 1, default: 10 },
      { key: "intensity", label: "Intensity", min: 0, max: 4, step: 0.05, default: 1 },
    ],
    // Two-pass in the exporter; the preview folds the edge pass into one shader,
    // which costs more per pixel but keeps the preview a single draw.
    fragment: `
      ${LUMINANCE}
      vec2 mashEdgeDirection(vec2 coords) {
        float hor = mashEdgeDelta(coords, vec2(0.001, 0.0));
        float ver = mashEdgeDelta(coords, vec2(0.0, 0.001));
        return vec2(ver, -hor);
      }
      vec3 mashDirBlur(vec2 coords, vec2 direction) {
        vec3 outC = vec3(0.0);
        const int radius = 12;
        float weightSum = 0.0;
        for (int i = -radius; i <= radius; i++) {
          vec2 pos = coords + direction * float(i);
          float weight = 1.0 - abs(float(i)) / float(radius + 1);
          outC += texture2D(uSampler, pos).rgb * weight;
          weightSum += weight;
        }
        return outC / weightSum;
      }
      void main() {
        const int rad = 8;
        vec2 aggregate = vec2(0.0);
        float weightSum = 0.0;
        for (int x = -rad; x <= rad; x += 2) {
          for (int y = -rad; y <= rad; y += 2) {
            vec2 at = vTexCoord + vec2(float(x), float(y)) * (0.002 * p0);
            vec2 edge = mashEdgeDirection(at);
            float weight = 1.0 - sqrt(float(x*x + y*y)) / sqrt(float(rad*rad + rad*rad + 1));
            aggregate += edge * weight;
            weightSum += weight;
          }
        }
        aggregate /= weightSum;
        gl_FragColor = vec4(mashDirBlur(vTexCoord, aggregate * p1 * 0.1), 1.0);
      }`,
  },
];

export const filterByName = (name: string) => FILTERS.find((f) => f.name === name);

export const defaultParams = (name: string): Record<string, number> => {
  const def = filterByName(name);
  const out: Record<string, number> = {};
  def?.params.forEach((p) => { out[p.key] = p.default; });
  return out;
};
