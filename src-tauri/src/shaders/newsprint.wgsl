// 360mash "News Print". p0 = scale, p1 = angle, p2 = brightness.
fn dot_screen(scale: f32, uv: vec2<f32>) -> f32 {
    let p = vec2<f32>(0.7, 0.7) * uv / vec2<f32>(u.inv_width, u.inv_height);
    // GLSL mat2(cos, -sin, sin, cos) is column major, so this is the product.
    let c = cos(u.p1);
    let s = sin(u.p1);
    let q = vec2<f32>(c * p.x + s * p.y, -s * p.x + c * p.y) * scale;
    return sin(q.x) * sin(q.y) * 5.0;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let tex = textureSample(src, samp, in.uv);
    let scale = 0.3 + 0.8 * u.p0;
    let out_rgb = tex.rgb * u.p2 - vec3<f32>(5.0 + dot_screen(scale, in.uv));
    return vec4<f32>(out_rgb, 1.0);
}
