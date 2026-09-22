// 360mash "Monet": a Kuwahara filter. Each quadrant's mean and variance is
// measured and the flattest quadrant wins, which is what gives the painted,
// smeared-into-patches look.
//
// RADIUS is injected as a constant rather than a uniform, exactly as in the
// original, because a dynamic loop bound is markedly slower.
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel = vec2<f32>(u.inv_width, u.inv_height);

    var sum0 = vec3<f32>(0.0); var sum_sq0 = vec3<f32>(0.0); var n0 = 0.0;
    var sum1 = vec3<f32>(0.0); var sum_sq1 = vec3<f32>(0.0); var n1 = 0.0;
    var sum2 = vec3<f32>(0.0); var sum_sq2 = vec3<f32>(0.0); var n2 = 0.0;
    var sum3 = vec3<f32>(0.0); var sum_sq3 = vec3<f32>(0.0); var n3 = 0.0;

    for (var i = 0; i <= RADIUS; i = i + 1) {
        for (var j = 0; j <= RADIUS; j = j + 1) {
            let off = vec2<f32>(f32(i), f32(j)) * texel;

            let c_a = textureSample(src, samp, in.uv + vec2<f32>( off.x,  off.y)).rgb;
            sum0 = sum0 + c_a; sum_sq0 = sum_sq0 + c_a * c_a; n0 = n0 + 1.0;

            let c_b = textureSample(src, samp, in.uv + vec2<f32>(-off.x,  off.y)).rgb;
            sum1 = sum1 + c_b; sum_sq1 = sum_sq1 + c_b * c_b; n1 = n1 + 1.0;

            let c_c = textureSample(src, samp, in.uv + vec2<f32>( off.x, -off.y)).rgb;
            sum2 = sum2 + c_c; sum_sq2 = sum_sq2 + c_c * c_c; n2 = n2 + 1.0;

            let c_d = textureSample(src, samp, in.uv + vec2<f32>(-off.x, -off.y)).rgb;
            sum3 = sum3 + c_d; sum_sq3 = sum_sq3 + c_d * c_d; n3 = n3 + 1.0;
        }
    }

    let mean0 = sum0 / n0; let v0v = sum_sq0 / n0 - mean0 * mean0; let var0 = v0v.r + v0v.g + v0v.b;
    let mean1 = sum1 / n1; let v1v = sum_sq1 / n1 - mean1 * mean1; let var1 = v1v.r + v1v.g + v1v.b;
    let mean2 = sum2 / n2; let v2v = sum_sq2 / n2 - mean2 * mean2; let var2 = v2v.r + v2v.g + v2v.b;
    let mean3 = sum3 / n3; let v3v = sum_sq3 / n3 - mean3 * mean3; let var3 = v3v.r + v3v.g + v3v.b;

    var out_color = mean0;
    var min_var = var0;
    if (var1 < min_var) { min_var = var1; out_color = mean1; }
    if (var2 < min_var) { min_var = var2; out_color = mean2; }
    if (var3 < min_var) { min_var = var3; out_color = mean3; }

    return vec4<f32>(out_color, 1.0);
}
