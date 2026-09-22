// 360mash "Cartoon". p0 = edge intensity, p1 = colour count, p2 = brightness levels.
fn display_to_linear(color: vec3<f32>) -> vec3<f32> { return pow(color, vec3<f32>(0.455)); }
fn linear_to_display(color: vec3<f32>) -> vec3<f32> { return pow(color, vec3<f32>(2.2)); }

fn to_hsv(color_in: vec3<f32>) -> vec3<f32> {
    let color = display_to_linear(color_in);
    let r = color.r;
    let g = color.g;
    let b = color.b;
    let v = max(max(r, g), b);
    let x_min = min(min(r, g), b);
    let c = v - x_min;
    var h = 0.0;
    if (c == 0.0) {
        h = 0.0;
    } else if (v == r) {
        h = 60.0 * (0.0 + (g - b) / c);
    } else if (v == g) {
        h = 60.0 * (2.0 + (b - r) / c);
    } else {
        h = 60.0 * (4.0 + (r - g) / c);
    }
    var s = 0.0;
    if (v != 0.0) { s = c / v; }
    return vec3<f32>(h, s, v);
}

fn from_hsv_helper(n: f32, hsv: vec3<f32>) -> f32 {
    let k = glsl_mod(n + hsv.x / 60.0, 6.0);
    return hsv.z - hsv.z * hsv.y * max(0.0, min(min(k, 4.0 - k), 1.0));
}

fn from_hsv(hsv: vec3<f32>) -> vec3<f32> {
    return linear_to_display(vec3<f32>(
        from_hsv_helper(5.0, hsv),
        from_hsv_helper(3.0, hsv),
        from_hsv_helper(1.0, hsv),
    ));
}

fn quantize(v: f32, levels: f32) -> f32 { return floor(v * levels) / levels; }

fn edge_strength(coords: vec2<f32>) -> f32 {
    let hor = edge_strength_with_delta(coords, vec2<f32>(u.inv_width * 1.75, 0.0));
    let ver = edge_strength_with_delta(coords, vec2<f32>(0.0, u.inv_height * 1.75));
    return (abs(hor) + abs(ver)) * 0.5;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(src, samp, in.uv);
    var hsv = to_hsv(c.rgb);
    hsv.y = quantize(hsv.y, u.p1 * 1.33);
    hsv.z = quantize(hsv.z, u.p2);
    var out_rgb = from_hsv(hsv);
    let edge = edge_strength(in.uv) * u.p0;
    out_rgb = out_rgb * (1.0 - smoothstep(0.04, 0.1, edge));
    return vec4<f32>(out_rgb, 1.0);
}
