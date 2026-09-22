// 360mash "Grayscale". Ported from its GLSL, which averages the three
// channels equally rather than using a luminance weighting.
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let c = textureSample(src, samp, in.uv);
    return vec4<f32>(vec3<f32>(0.333) * (c.r + c.g + c.b), 1.0);
}
