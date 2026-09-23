// "Pencil Drawing": a detailed graphite sketch.
//
// The tone comes from the classic dodge trick — divide the grey by one minus
// its blurred inverse. That leaves paper-white flats while pulling out every
// small change in shading, which is what makes it read as finely worked
// pencil rather than a threshold.
//
// On top of that: crisp contour lines from a one-pixel gradient, cross
// hatching that builds up in layers as the tone darkens (the way a pencil
// drawing actually gets its darks), and a little paper grain.
//
// The dodge alone leaves every flat area paper-white however dark it really
// is, so the shading is driven by the local brightness instead: that is what
// darkens the paper and decides how many layers of hatching build up.
//
// p0 is the blur radius, baked in as RADIUS. p1 = line strength,
// p2 = hatching, p3 = paper, p4 = contrast, p5 = shading depth.

// A hatch line set at a given angle. Returns 1 on a stroke, 0 between them.
fn hatch(uv: vec2<f32>, texel: vec2<f32>, angle: f32, freq: f32) -> f32 {
    let p = uv / texel;
    let q = p.x * cos(angle) + p.y * sin(angle);
    // Slight waver so the strokes are not mechanically straight.
    let waver = vnoise(p * 0.02) * 2.0;
    return 1.0 - smoothstep(0.0, 0.42, abs(sin((q + waver) * freq)));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel = vec2<f32>(u.inv_width, u.inv_height);

    // Finish the separable blur started in the first pass.
    let sigma = max(f32(RADIUS) * 0.5, 0.5);
    var blurred = 0.0;
    var wsum = 0.0;
    for (var i = -RADIUS; i <= RADIUS; i = i + 1) {
        let y = f32(i);
        let w = exp(-(y * y) / (2.0 * sigma * sigma));
        blurred = blurred + textureSample(aux, samp, in.uv + vec2<f32>(0.0, texel.y * y)).r * w;
        wsum = wsum + w;
    }
    blurred = blurred / wsum;

    let grey = luminance(textureSample(src, samp, in.uv).rgb);
    var tone = clamp(grey / max(1.0 - blurred, 0.004), 0.0, 1.0);

    // How bright the picture is around here, which is what a person drawing
    // would judge the shading from.
    let local = clamp(1.0 - blurred, 0.0, 1.0);
    tone = tone * mix(1.0, 0.25 + 0.75 * local, u.p5);

    // Contour lines, measured at one pixel so fine detail survives.
    let g = gradient_at(in.uv, texel, 1.0);
    let edge = smoothstep(0.02, 0.22, length(g));
    tone = tone - edge * u.p1 * 0.85;

    // Hatching builds up in layers as the subject darkens, each fading in
    // rather than switching on, so there is no banding where a layer starts.
    let freq = 0.55;
    let strength = u.p2 * 0.30;
    tone = tone - strength * hatch(in.uv, texel, 0.785, freq) * smoothstep(0.80, 0.55, local);
    tone = tone - strength * hatch(in.uv, texel, -0.785, freq) * smoothstep(0.55, 0.32, local);
    tone = tone - strength * hatch(in.uv, texel, 0.0, freq) * smoothstep(0.32, 0.12, local);

    // Contrast about the mid grey, then paper.
    tone = clamp((tone - 0.5) * u.p4 + 0.5, 0.0, 1.0);
    let paper = 1.0 - u.p3 * 0.10 * vnoise(in.uv / texel * 0.8);
    tone = clamp(tone * paper, 0.0, 1.0);

    return vec4<f32>(vec3<f32>(tone), 1.0);
}
