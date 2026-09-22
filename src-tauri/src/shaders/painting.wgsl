// 360mash "Painting", second pass. p0 = radius, p1 = intensity.
//
// Smooths the edge directions from the first pass over a neighbourhood, then
// blurs along that direction, so colour is dragged along edges like a brush
// stroke rather than blurred evenly.
fn dir_blur(coords: vec2<f32>, direction: vec2<f32>) -> vec3<f32> {
    var out_c = vec3<f32>(0.0);
    let radius = 12;
    var weight_sum = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
        let pos = coords + direction * f32(i);
        let c = textureSample(src, samp, pos).rgb;
        let weight = 1.0 - abs(f32(i)) / f32(radius + 1);
        out_c = out_c + c * weight;
        weight_sum = weight_sum + weight;
    }
    return out_c / weight_sum;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // 'rad' is the spatial extent, 'step' the sampling density; the original
    // skips every other tap to keep the cost down.
    let rad = 8;
    let step_by = 2;
    var aggregate = vec2<f32>(0.0);
    var weight_sum = 0.0;
    for (var x = -rad; x <= rad; x = x + step_by) {
        for (var y = -rad; y <= rad; y = y + step_by) {
            let at = in.uv + vec2<f32>(f32(x), f32(y)) * (0.002 * u.p0);
            let edge_tex = textureSample(aux, samp, at).xy;
            let edge = (edge_tex * 2.0) - vec2<f32>(1.0);
            let weight = 1.0 - sqrt(f32(x * x + y * y)) / sqrt(f32(rad * rad + rad * rad + 1));
            aggregate = aggregate + edge * weight;
            weight_sum = weight_sum + weight;
        }
    }
    aggregate = aggregate / weight_sum;
    return vec4<f32>(dir_blur(in.uv, aggregate * u.p1 * 0.1), 1.0);
}
