// 360mash "Charcoal". p0 = intensity, p1 = inverse (0 or 1).
fn edge_strength(coords: vec2<f32>) -> f32 {
    let aspect = u.inv_height / u.inv_width;
    let x_step = 0.00162;
    let y_step = x_step * aspect;
    let hor = edge_strength_with_delta(coords, vec2<f32>(x_step, 0.0));
    let ver = edge_strength_with_delta(coords, vec2<f32>(0.0, y_step));
    return (abs(hor) + abs(ver)) * 0.2;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let tex = textureSample(src, samp, in.uv);
    var out_rgb = (tex.r + tex.g + tex.b) * vec3<f32>(0.333);

    let edge = edge_strength(in.uv) * u.p0 * 5.5;

    // The original picks between two smoothstep edges depending on 'inverse'.
    var x = 0.11;
    if (u.p1 == 1.0) {
        x = 0.04;
    }
    out_rgb = out_rgb * (1.0 - smoothstep(x, 0.1, edge));

    // Anything not fully suppressed is driven to white, giving the hard
    // black-on-white look.
    if (any(out_rgb != vec3<f32>(0.0))) {
        out_rgb = vec3<f32>(1.0);
    }
    return vec4<f32>(out_rgb, 1.0);
}
