// Shared by every filter: a full-screen triangle and the uniform block.
//
// The parameter slots are generic (p0..p5) so that one bind group layout
// serves all filters; each shader names the slots it uses at the top.

struct Uniforms {
    inv_width: f32,
    inv_height: f32,
    p0: f32,
    p1: f32,
    p2: f32,
    p3: f32,
    p4: f32,
    p5: f32,
    p6: f32,
    p7: f32,
    // A uniform struct has to be a multiple of 16 bytes.
    _pad0: f32,
    _pad1: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;
// Second input, used by multi-pass filters. Bound to the source texture when
// a filter does not need it, so one layout serves every shader.
@group(0) @binding(3) var aux: texture_2d<f32>;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
    // One oversized triangle covering the viewport.
    var xy = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    var out: VsOut;
    let p = xy[idx];
    out.pos = vec4<f32>(p, 0.0, 1.0);
    // Texture rows run top-down, clip space runs bottom-up.
    out.uv = vec2<f32>((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
    return out;
}
