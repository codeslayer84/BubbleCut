// 360mash "Pixelate". p0 = block size in pixels.
@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let texel_size = vec2<f32>(u.inv_width, u.inv_height);
    let pixel_coord = in.uv / texel_size;
    let block_coord = (floor(pixel_coord / u.p0) + 0.5) * u.p0;
    let uv = block_coord * texel_size;
    return textureSample(src, samp, uv);
}
