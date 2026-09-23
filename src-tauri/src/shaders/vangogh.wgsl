// A Van Gogh filter: swirling, directional brush strokes with raised paint.
//
// Not a 360mash port. The idea is that strokes follow the image's contours
// rather than its gradients, which is what gives Starry Night its swirls, so
// the flow direction is the tangent of the luminance gradient. Noise is
// smeared along that flow (a line integral convolution) to make the bristle
// streaks, and the same smeared noise is sampled again slightly across the
// stroke so the difference can light the ridges like thick paint.
//
// p0 unused (stroke length is baked in as RADIUS), p1 = stroke detail,
// p2 = impasto, p3 = saturation.

// Direction the brush travels: along contours, not across them.
//
// Averaging raw gradients would cancel out, because a direction and its
// opposite describe the same stroke. Averaging the structure tensor instead
// keeps that ambiguity out of it, and its minor eigenvector is the direction
// along which the picture changes least — the contour. Without this smoothing
// the strokes scatter wherever the detail is fine.
fn flow_at(uv: vec2<f32>, texel: vec2<f32>) -> vec2<f32> {
    var jxx = 0.0;
    var jxy = 0.0;
    var jyy = 0.0;
    let spread = 3.0;
    for (var i = -1; i <= 1; i = i + 1) {
        for (var j = -1; j <= 1; j = j + 1) {
            let at = uv + vec2<f32>(f32(i), f32(j)) * texel * spread;
            let g = gradient_at(at, texel, 2.0);
            jxx = jxx + g.x * g.x;
            jxy = jxy + g.x * g.y;
            jyy = jyy + g.y * g.y;
        }
    }

    if (jxx + jyy < 1e-5) {
        // Flat areas would otherwise come out smooth; a slow noise angle keeps
        // the sky moving.
        let a = vnoise(uv * 3.0) * 6.2831853;
        return vec2<f32>(cos(a), sin(a));
    }

    let diff = jxx - jyy;
    let root = sqrt(diff * diff + 4.0 * jxy * jxy);
    let major = 0.5 * (jxx + jyy + root);
    // Eigenvector for the larger eigenvalue points across the contour, so the
    // stroke runs perpendicular to it.
    let across = normalize(vec2<f32>(jxy, major - jxx) + vec2<f32>(1e-8, 0.0));
    return vec2<f32>(-across.y, across.x);
}

// Noise smeared along the stroke, which is what reads as bristle marks.
fn stroke_noise(uv: vec2<f32>, dir: vec2<f32>, texel: vec2<f32>, freq: f32) -> f32 {
    var total = 0.0;
    var count = 0.0;
    for (var i = -RADIUS; i <= RADIUS; i = i + 1) {
        let p = uv + dir * texel * f32(i) * 1.5;
        total = total + vnoise(p * freq);
        count = count + 1.0;
    }
    return total / count;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel = vec2<f32>(u.inv_width, u.inv_height);
    let dir = flow_at(in.uv, texel);
    let perp = vec2<f32>(-dir.y, dir.x);

    // Colour dragged along the stroke.
    var col = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var i = -RADIUS; i <= RADIUS; i = i + 1) {
        let t = f32(i);
        let p = in.uv + dir * texel * t * 1.5;
        let w = 1.0 - abs(t) / f32(RADIUS + 1);
        col = col + textureSample(src, samp, p).rgb * w;
        wsum = wsum + w;
    }
    col = col / wsum;

    let freq = 140.0 * max(u.p1, 0.01);
    let lic = stroke_noise(in.uv, dir, texel, freq);
    // Sampled again just across the stroke, so the difference is the slope of
    // the paint ridge rather than of the picture.
    let lic_side = stroke_noise(in.uv + perp * texel * 2.0, dir, texel, freq);
    let slope = lic_side - lic;

    // Bristle streaks, then light the ridges.
    col = col * (0.88 + 0.5 * (lic - 0.5));
    col = col + vec3<f32>(slope * u.p2 * 4.0);

    // Van Gogh's colour is not timid.
    let grey = dot(col, vec3<f32>(0.299, 0.587, 0.114));
    col = mix(vec3<f32>(grey), col, u.p3);

    return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
