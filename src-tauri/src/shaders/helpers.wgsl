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
