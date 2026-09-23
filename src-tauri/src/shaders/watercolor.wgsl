// "Watercolour": flat washes with pigment pooled at their edges.
//
// Four things make watercolour read as watercolour, and this does all of them:
//
//  * the paint pools into flat washes rather than shading smoothly, so the
//    colour is flattened with a Kuwahara filter, which keeps boundaries crisp
//  * water carries pigment past the drawing, so sampling is displaced by a
//    slow noise and the shapes wander off the underlying edges
//  * pigment collects where a wash dries at its rim, which is the dark line
//    around every shape
//  * pigment settles into the tooth of the paper, giving the grain
//
// RADIUS is the wash size, baked in. p1 = bleed, p2 = edge pooling,
// p3 = granulation, p4 = vibrance.

// Water pushing the pigment around, so the washes do not sit exactly on the
// picture's own edges.
fn bleed_uv(uv: vec2<f32>, texel: vec2<f32>, amount: f32) -> vec2<f32> {
    let n1 = vnoise(uv * 6.0);
    let n2 = vnoise(uv * 6.0 + vec2<f32>(37.0, 11.0));
    return uv + (vec2<f32>(n1, n2) - vec2<f32>(0.5)) * amount * texel * 18.0;
}

// Flattens into washes: of the four quadrants around a pixel, the most even
// one wins, so areas pool into flat colour without bleeding across a boundary.
fn wash(uv: vec2<f32>, texel: vec2<f32>) -> vec3<f32> {
    var sum0 = vec3<f32>(0.0); var sq0 = vec3<f32>(0.0);
    var sum1 = vec3<f32>(0.0); var sq1 = vec3<f32>(0.0);
    var sum2 = vec3<f32>(0.0); var sq2 = vec3<f32>(0.0);
    var sum3 = vec3<f32>(0.0); var sq3 = vec3<f32>(0.0);
    var n = 0.0;

    for (var i = 0; i <= RADIUS; i = i + 1) {
        for (var j = 0; j <= RADIUS; j = j + 1) {
            let off = vec2<f32>(f32(i), f32(j)) * texel;
            let a = textureSample(src, samp, uv + vec2<f32>( off.x,  off.y)).rgb;
            let b = textureSample(src, samp, uv + vec2<f32>(-off.x,  off.y)).rgb;
            let c = textureSample(src, samp, uv + vec2<f32>( off.x, -off.y)).rgb;
            let d = textureSample(src, samp, uv + vec2<f32>(-off.x, -off.y)).rgb;
            sum0 = sum0 + a; sq0 = sq0 + a * a;
            sum1 = sum1 + b; sq1 = sq1 + b * b;
            sum2 = sum2 + c; sq2 = sq2 + c * c;
            sum3 = sum3 + d; sq3 = sq3 + d * d;
            n = n + 1.0;
        }
    }

    let m0 = sum0 / n; let v0v = sq0 / n - m0 * m0; let v0 = v0v.r + v0v.g + v0v.b;
    let m1 = sum1 / n; let v1v = sq1 / n - m1 * m1; let v1 = v1v.r + v1v.g + v1v.b;
    let m2 = sum2 / n; let v2v = sq2 / n - m2 * m2; let v2 = v2v.r + v2v.g + v2v.b;
    let m3 = sum3 / n; let v3v = sq3 / n - m3 * m3; let v3 = v3v.r + v3v.g + v3v.b;

    var out = m0;
    var best = v0;
    if (v1 < best) { best = v1; out = m1; }
    if (v2 < best) { best = v2; out = m2; }
    if (v3 < best) { best = v3; out = m3; }
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel = vec2<f32>(u.inv_width, u.inv_height);
    let wuv = bleed_uv(in.uv, texel, u.p1);

    var col = wash(wuv, texel);

    // Pigment pooling at the rim of each wash. Catching softer edges too,
    // since the dark rim is the most recognisable thing about watercolour.
    let g = gradient_at(wuv, texel, 2.0);
    let rim = smoothstep(0.01, 0.16, length(g));
    col = col * (1.0 - 0.55 * u.p2 * rim);

    // No wash is ever perfectly even, so the pigment density wanders slowly
    // across the paper.
    let blotch = vnoise(in.uv * 14.0);
    col = col * (0.90 + 0.20 * blotch);

    // Granulation: pigment settles into the tooth of the paper, so it shows
    // most where the colour is heaviest.
    let lum = luminance(col);
    let pigment = clamp(1.0 - lum, 0.0, 1.0);
    let grain = vnoise(in.uv / texel * 0.55) * 0.65
              + vnoise(in.uv / texel * 1.7) * 0.35;
    col = col * (1.0 - 0.30 * u.p3 * grain * (0.35 + 0.65 * pigment));

    // Watercolour is luminous: strong pigment, but the paper shows through.
    let grey = dot(col, vec3<f32>(0.299, 0.587, 0.114));
    col = mix(vec3<f32>(grey), col, u.p4);
    col = mix(col, vec3<f32>(1.0), 0.07);

    return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
