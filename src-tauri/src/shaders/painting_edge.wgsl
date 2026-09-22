// 360mash "Painting", first pass: the direction of the local edge, packed
// into 0..1 so it survives an 8-bit render target.
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let hor = edge_strength_with_delta(in.uv, vec2<f32>(0.001, 0.0));
    let ver = edge_strength_with_delta(in.uv, vec2<f32>(0.0, 0.001));
    let edge = (vec2<f32>(ver, -hor) + vec2<f32>(1.0)) * 0.5;
    return vec4<f32>(edge, 1.0, 1.0);
}
