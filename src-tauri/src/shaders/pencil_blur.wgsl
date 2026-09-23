// "Pencil Drawing", first pass: a horizontal Gaussian blur of the inverted
// luminance. The second pass blurs this vertically, which makes the whole
// thing separable — 2x(2R+1) samples instead of (2R+1) squared.
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel = vec2<f32>(u.inv_width, u.inv_height);
    let sigma = max(f32(RADIUS) * 0.5, 0.5);
    var sum = 0.0;
    var wsum = 0.0;
    for (var i = -RADIUS; i <= RADIUS; i = i + 1) {
        let x = f32(i);
        let w = exp(-(x * x) / (2.0 * sigma * sigma));
        let c = textureSample(src, samp, in.uv + vec2<f32>(texel.x * x, 0.0)).rgb;
        sum = sum + (1.0 - luminance(c)) * w;
        wsum = wsum + w;
    }
    let v = sum / wsum;
    return vec4<f32>(v, v, v, 1.0);
}
