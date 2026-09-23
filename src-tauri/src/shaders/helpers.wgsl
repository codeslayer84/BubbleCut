// GLSL's mod() floors; WGSL's % truncates. The ports rely on the GLSL one.
fn glsl_mod(x: f32, y: f32) -> f32 {
    return x - y * floor(x / y);
}

// As used throughout 360mash: a sqrt "linearisation" then Rec.709 weights.
fn luminance(c: vec3<f32>) -> f32 {
    let lin = sqrt(c);
    return lin.r * 0.2126 + lin.g * 0.7152 + lin.b * 0.0722;
}

// Difference in luminance across a step, averaged over three parallel taps.
fn edge_strength_with_delta(start: vec2<f32>, delta: vec2<f32>) -> f32 {
    let perp = vec2<f32>(delta.y, -delta.x);
    var before = 0.0;
    for (var i = -1; i <= 1; i = i + 1) {
        let pos = start - delta + f32(i) * perp;
        before = before + luminance(textureSample(src, samp, pos).rgb);
    }
    var after = 0.0;
    for (var i = -1; i <= 1; i = i + 1) {
        let pos = start + delta + f32(i) * perp;
        after = after + luminance(textureSample(src, samp, pos).rgb);
    }
    return (after - before) * 0.3333;
}

// Value noise, shared by the painterly filters.
fn hash21(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f0 = fract(p);
    let f = f0 * f0 * (3.0 - 2.0 * f0);
    let a = hash21(i);
    let b = hash21(i + vec2<f32>(1.0, 0.0));
    let c = hash21(i + vec2<f32>(0.0, 1.0));
    let d = hash21(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Luminance gradient, used to find edges and stroke directions.
fn gradient_at(uv: vec2<f32>, texel: vec2<f32>, step: f32) -> vec2<f32> {
    let gx = luminance(textureSample(src, samp, uv + vec2<f32>(texel.x * step, 0.0)).rgb)
           - luminance(textureSample(src, samp, uv - vec2<f32>(texel.x * step, 0.0)).rgb);
    let gy = luminance(textureSample(src, samp, uv + vec2<f32>(0.0, texel.y * step)).rgb)
           - luminance(textureSample(src, samp, uv - vec2<f32>(0.0, texel.y * step)).rgb);
    return vec2<f32>(gx, gy);
}

// Rotates hue by `a` radians. Written out rather than as a matrix so there is
// no doubt about which way round the columns go.
fn hue_rotate(col: vec3<f32>, a: f32) -> vec3<f32> {
    let c = cos(a);
    let s = sin(a);
    let r = col.r;
    let g = col.g;
    let b = col.b;
    return vec3<f32>(
        (0.299 + 0.701 * c + 0.168 * s) * r + (0.587 - 0.587 * c + 0.330 * s) * g + (0.114 - 0.114 * c - 0.497 * s) * b,
        (0.299 - 0.299 * c - 0.328 * s) * r + (0.587 + 0.413 * c + 0.035 * s) * g + (0.114 - 0.114 * c + 0.292 * s) * b,
        (0.299 - 0.300 * c + 1.250 * s) * r + (0.587 - 0.588 * c - 1.050 * s) * g + (0.114 + 0.886 * c - 0.203 * s) * b,
    );
}

// Pushes the dull colours hardest and leaves the already-vivid ones be, so
// that flat areas gain colour instead of the strong ones clipping.
fn vibrance(col: vec3<f32>, amount: f32) -> vec3<f32> {
    let mx = max(col.r, max(col.g, col.b));
    let mn = min(col.r, min(col.g, col.b));
    let sat = clamp(mx - mn, 0.0, 1.0);
    let grey = dot(col, vec3<f32>(0.299, 0.587, 0.114));
    return mix(vec3<f32>(grey), col, 1.0 + amount * (1.0 - sat));
}
