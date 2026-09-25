//! Running 360mash's image filters on the GPU.
//!
//! 360mash applies these as WebGL fragment shaders and then encodes with a
//! WebAssembly build of libav, which is what makes its export slow. Here the
//! same shader maths runs through wgpu while ffmpeg keeps doing the decoding
//! and the hardware encoding, so the looks match but the speed does not drop.
//!
//! Frames arrive and leave as tightly packed RGBA8.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, thiserror::Error)]
pub enum GpuError {
    #[error("no suitable GPU adapter found")]
    NoAdapter,
    #[error("GPU device request failed: {0}")]
    Device(String),
    #[error("frame is {got} bytes, expected {want} for {w}x{h} RGBA")]
    FrameSize { got: usize, want: usize, w: u32, h: u32 },
    #[error("unknown filter '{0}'")]
    UnknownFilter(String),
    #[error("reading the processed frame back failed: {0}")]
    Readback(String),
}

/// One filter in the chain, named the way 360mash names it in its UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub name: String,
    /// Filter parameters by name; anything missing falls back to the default.
    #[serde(default)]
    pub params: HashMap<String, f32>,
}

/// Which generic uniform slot each named parameter occupies, and its default.
/// Defaults are taken from 360mash so an unconfigured filter looks the same.
pub fn filter_params(name: &str) -> Option<&'static [(&'static str, usize, f32)]> {
    match name {
        "Grayscale" => Some(&[]),
        "Pixelate" => Some(&[("blockSize", 0, 16.0)]),
        "Charcoal" => Some(&[("intensity", 0, 1.0), ("inverse", 1, 0.0)]),
        "News Print" => Some(&[("scale", 0, 0.3), ("angle", 1, 2.0), ("brightness", 2, 9.5)]),
        "Cartoon" => Some(&[
            ("edgeIntensity", 0, 1.0),
            ("colorCount", 1, 6.0),
            ("colorBright", 2, 10.0),
        ]),
        // Radius recompiles the shader rather than feeding a uniform, exactly
        // as in 360mash: a dynamic loop bound is far slower here.
        "Monet" => Some(&[("radius", 0, 3.0)]),
        // Stroke length is baked in too, for the same reason as Monet.
        "Van Gogh" => Some(&[
            ("strokeLength", 0, 14.0),
            ("strokeDetail", 1, 1.0),
            ("impasto", 2, 1.0),
            ("saturation", 3, 1.35),
        ]),
        "Painting" => Some(&[("radius", 0, 10.0), ("intensity", 1, 1.0)]),
        "Watercolour" => Some(&[
            ("washSize", 0, 4.0),
            ("bleed", 1, 1.0),
            ("pooling", 2, 1.0),
            ("granulation", 3, 1.0),
            ("vibrance", 4, 1.8),
            ("hueVariation", 5, 0.8),
            ("warmCool", 6, 0.7),
        ]),
        "Pencil Drawing" => Some(&[
            ("shading", 0, 6.0),
            ("lineStrength", 1, 1.0),
            ("hatching", 2, 1.0),
            ("paper", 3, 1.0),
            ("contrast", 4, 1.0),
            ("tone", 5, 0.5),
        ]),
        // Internal passes, deliberately absent from available_filters() so
        // they never show up as something to choose.
        "Painting.edge" => Some(&[]),
        "Pencil Drawing.blur" => Some(&[("shading", 0, 6.0)]),
        _ => None,
    }
}

/// Every filter this build can apply, in the order 360mash lists them.
pub fn available_filters() -> Vec<String> {
    ["Grayscale", "Pixelate", "News Print", "Charcoal", "Cartoon", "Monet", "Painting", "Van Gogh", "Watercolour", "Pencil Drawing"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Filters needing an extra pass first, whose output the main pass reads.
fn prepass_of(name: &str) -> Option<&'static str> {
    match name {
        "Painting" => Some("Painting.edge"),
        "Pencil Drawing" => Some("Pencil Drawing.blur"),
        _ => None,
    }
}

fn shader_source(name: &str) -> Option<&'static str> {
    let body = match name {
        "Grayscale" => include_str!("shaders/grayscale.wgsl"),
        "Pixelate" => include_str!("shaders/pixelate.wgsl"),
        "Charcoal" => include_str!("shaders/charcoal.wgsl"),
        "News Print" => include_str!("shaders/newsprint.wgsl"),
        "Cartoon" => include_str!("shaders/cartoon.wgsl"),
        "Monet" => include_str!("shaders/monet.wgsl"),
        "Van Gogh" => include_str!("shaders/vangogh.wgsl"),
        "Painting" => include_str!("shaders/painting.wgsl"),
        "Painting.edge" => include_str!("shaders/painting_edge.wgsl"),
        "Watercolour" => include_str!("shaders/watercolor.wgsl"),
        "Pencil Drawing" => include_str!("shaders/pencil.wgsl"),
        "Pencil Drawing.blur" => include_str!("shaders/pencil_blur.wgsl"),
        _ => return None,
    };
    Some(body)
}

const AUX: usize = 2;

const COMMON: &str = include_str!("shaders/common.wgsl");
const HELPERS: &str = include_str!("shaders/helpers.wgsl");

/// Some filters bake a loop bound into the shader rather than feed it as a
/// uniform, because a dynamic bound is markedly slower. Each value is then a
/// pipeline of its own.
fn pipeline_key(name: &str, spec: &FilterSpec) -> String {
    match name {
        "Monet" | "Van Gogh" | "Watercolour" | "Pencil Drawing" | "Pencil Drawing.blur" =>
            format!("{name}@{}", baked_radius(name, spec)),
        _ => name.to_string(),
    }
}

fn baked_radius(name: &str, spec: &FilterSpec) -> i32 {
    match name {
        "Monet" => spec.params.get("radius").copied().unwrap_or(3.0).round().clamp(1.0, 12.0) as i32,
        "Van Gogh" => spec.params.get("strokeLength").copied().unwrap_or(14.0).round().clamp(2.0, 30.0) as i32,
        "Watercolour" => spec.params.get("washSize").copied().unwrap_or(4.0).round().clamp(1.0, 10.0) as i32,
        "Pencil Drawing" | "Pencil Drawing.blur" =>
            spec.params.get("shading").copied().unwrap_or(6.0).round().clamp(1.0, 16.0) as i32,
        _ => 0,
    }
}

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    inv_width: f32,
    inv_height: f32,
    p: [f32; 8],
    /// Keeps the block a multiple of 16 bytes, as uniforms require.
    _pad: [f32; 2],
}

pub struct FilterGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
    width: u32,
    height: u32,
    textures: Vec<wgpu::Texture>,
    readback: Option<wgpu::Buffer>,
    padded_bytes_per_row: u32,
}

impl FilterGpu {
    pub fn new() -> Result<Self, GpuError> {
        pollster::block_on(Self::new_async())
    }

    async fn new_async() -> Result<Self, GpuError> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .ok_or(GpuError::NoAdapter)?;
        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("360 editor filters"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .map_err(|e| GpuError::Device(e.to_string()))?;

        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("filter bind group"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });

        // WebGL clamps to the edge by default, which the ported shaders rely
        // on when they sample past the border.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("filter sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        Ok(Self {
            device,
            queue,
            layout,
            sampler,
            pipelines: HashMap::new(),
            width: 0,
            height: 0,
            textures: Vec::new(),
            readback: None,
            padded_bytes_per_row: 0,
        })
    }

    fn ensure_pipeline(&mut self, name: &str, key: &str, radius: i32) -> Result<(), GpuError> {
        if !self.pipelines.contains_key(key) {
            let body = shader_source(name).ok_or_else(|| GpuError::UnknownFilter(name.to_string()))?;
            let consts = format!("const RADIUS: i32 = {radius};\n");
            let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(key),
                source: wgpu::ShaderSource::Wgsl(
                    format!("{COMMON}\n{consts}{HELPERS}\n{body}").into(),
                ),
            });
            let pipeline_layout = self.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(key),
                bind_group_layouts: &[&self.layout],
                push_constant_ranges: &[],
            });
            let pipeline = self.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(key),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });
            self.pipelines.insert(key.to_string(), pipeline);
        }
        Ok(())
    }

    fn ensure_size(&mut self, width: u32, height: u32) {
        if self.width == width && self.height == height {
            return;
        }
        self.width = width;
        self.height = height;

        // Two textures ping-ponged for the chain, plus a third that multi-pass
        // filters render their intermediate into.
        self.textures = (0..3)
            .map(|i| {
                self.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(match i { 0 => "frame a", 1 => "frame b", _ => "frame aux" }),
                    size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::COPY_DST
                        | wgpu::TextureUsages::COPY_SRC,
                    view_formats: &[],
                })
            })
            .collect();

        // Copies out of a texture need rows aligned to 256 bytes.
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        self.padded_bytes_per_row = (width * 4 + align - 1) / align * align;
        self.readback = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: (self.padded_bytes_per_row * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        }));
    }

    /// Runs the chain over one RGBA8 frame, writing the result into `out`.
    pub fn process(
        &mut self,
        frame: &[u8],
        width: u32,
        height: u32,
        chain: &[FilterSpec],
        out: &mut Vec<u8>,
    ) -> Result<(), GpuError> {
        let want = (width as usize) * (height as usize) * 4;
        if frame.len() != want {
            return Err(GpuError::FrameSize { got: frame.len(), want, w: width, h: height });
        }
        self.ensure_size(width, height);

        self.queue.write_texture(
            wgpu::ImageCopyTexture {
                texture: &self.textures[0],
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            frame,
            wgpu::ImageDataLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );

        let mut source = 0usize;
        for spec in chain {
            let uniforms = self.uniforms_for(spec, width, height)?;

            // A multi-pass filter renders its first pass into the aux texture,
            // which the main pass then reads alongside the original frame.
            if let Some(pre) = prepass_of(&spec.name) {
                let pre_key = pipeline_key(pre, spec);
                let pre_radius = baked_radius(pre, spec);
                self.run_pass(pre, &pre_key, pre_radius, &uniforms, source, AUX, source)?;
            }
            let aux = if prepass_of(&spec.name).is_some() { AUX } else { source };

            let key = pipeline_key(&spec.name, spec);
            let radius = baked_radius(&spec.name, spec);
            let dest = 1 - source;
            self.run_pass(&spec.name, &key, radius, &uniforms, source, dest, aux)?;
            source = dest;
        }

        self.read_back(source, width, height, out)
    }

    /// Renders one shader pass from `source` (and `aux`) into `dest`.
    fn run_pass(
        &mut self,
        name: &str,
        key: &str,
        radius: i32,
        uniforms: &Uniforms,
        source: usize,
        dest: usize,
        aux: usize,
    ) -> Result<(), GpuError> {
        self.ensure_pipeline(name, key, radius)?;

        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.queue.write_buffer(&buffer, 0, bytemuck::bytes_of(uniforms));

        let src_view = self.textures[source].create_view(&Default::default());
        let dst_view = self.textures[dest].create_view(&Default::default());
        let aux_view = self.textures[aux].create_view(&Default::default());
        let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("filter inputs"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&src_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&aux_view) },
            ],
        });

        let pipeline = self.pipelines.get(key).unwrap().clone();
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(key),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &dst_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit(Some(encoder.finish()));
        Ok(())
    }

    fn uniforms_for(&self, spec: &FilterSpec, width: u32, height: u32) -> Result<Uniforms, GpuError> {
        let defs = filter_params(&spec.name)
            .ok_or_else(|| GpuError::UnknownFilter(spec.name.clone()))?;
        let mut p = [0.0f32; 8];
        for (key, slot, default) in defs {
            p[*slot] = *spec.params.get(*key).copied().get_or_insert(*default);
        }
        Ok(Uniforms {
            inv_width: 1.0 / width as f32,
            inv_height: 1.0 / height as f32,
            p,
            _pad: [0.0; 2],
        })
    }

    fn read_back(&mut self, index: usize, width: u32, height: u32, out: &mut Vec<u8>) -> Result<(), GpuError> {
        let buffer = self.readback.as_ref().unwrap();
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::ImageCopyTexture {
                texture: &self.textures[index],
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyBuffer {
                buffer,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.queue.submit(Some(encoder.finish()));

        let slice = buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); });
        self.device.poll(wgpu::Maintain::Wait);
        rx.recv()
            .map_err(|e| GpuError::Readback(e.to_string()))?
            .map_err(|e| GpuError::Readback(e.to_string()))?;

        out.clear();
        out.reserve((width * height * 4) as usize);
        {
            let mapped = slice.get_mapped_range();
            let row = (width * 4) as usize;
            for y in 0..height as usize {
                let start = y * self.padded_bytes_per_row as usize;
                out.extend_from_slice(&mapped[start..start + row]);
            }
        }
        buffer.unmap();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, params: &[(&str, f32)]) -> FilterSpec {
        FilterSpec {
            name: name.to_string(),
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    // A small frame with distinctive, non-symmetric content so that a flip or
    // a channel swap cannot pass unnoticed.
    fn test_frame(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                v.push((x * 255 / w.max(1)) as u8);
                v.push((y * 255 / h.max(1)) as u8);
                v.push(if x < w / 2 { 200 } else { 40 });
                v.push(255);
            }
        }
        v
    }

    #[test]
    fn gpu_is_available_and_grayscale_matches_the_glsl() {
        let mut gpu = FilterGpu::new().expect("a GPU should be available");
        let (w, h) = (64u32, 32u32);
        let frame = test_frame(w, h);
        let mut out = Vec::new();
        gpu.process(&frame, w, h, &[spec("Grayscale", &[])], &mut out).unwrap();
        assert_eq!(out.len(), frame.len());

        // 360mash's shader is vec3(0.333) * (r + g + b), deliberately not a
        // luminance weighting, and it happens on 0..1 floats.
        let mut worst = 0i32;
        for i in (0..frame.len()).step_by(4) {
            let sum = frame[i] as f32 / 255.0 + frame[i + 1] as f32 / 255.0 + frame[i + 2] as f32 / 255.0;
            let want = (0.333 * sum * 255.0).round().clamp(0.0, 255.0) as i32;
            for c in 0..3 {
                worst = worst.max((out[i + c] as i32 - want).abs());
            }
            assert_eq!(out[i + 3], 255, "alpha should be opaque");
        }
        assert!(worst <= 1, "grayscale differs from the GLSL by {worst}");
    }

    #[test]
    fn pixelate_quantises_to_blocks() {
        let mut gpu = FilterGpu::new().unwrap();
        let (w, h) = (64u32, 64u32);
        let frame = test_frame(w, h);
        let mut out = Vec::new();
        gpu.process(&frame, w, h, &[spec("Pixelate", &[("blockSize", 16.0)])], &mut out).unwrap();

        // Every pixel in a block must carry the block's sampled colour.
        let at = |buf: &[u8], x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            [buf[i], buf[i + 1], buf[i + 2]]
        };
        for by in 0..4u32 {
            for bx in 0..4u32 {
                let first = at(&out, bx * 16, by * 16);
                for dy in 0..16u32 {
                    for dx in 0..16u32 {
                        let got = at(&out, bx * 16 + dx, by * 16 + dy);
                        assert_eq!(got, first, "block ({bx},{by}) is not flat at +({dx},{dy})");
                    }
                }
            }
        }
        // ...and blocks must differ from each other, or we filtered nothing.
        assert_ne!(at(&out, 0, 0), at(&out, 32, 32));
    }

    #[test]
    fn chain_applies_filters_in_order() {
        let mut gpu = FilterGpu::new().unwrap();
        let (w, h) = (32u32, 32u32);
        let frame = test_frame(w, h);
        let mut out = Vec::new();
        gpu.process(&frame, w, h,
                    &[spec("Pixelate", &[("blockSize", 8.0)]), spec("Grayscale", &[])],
                    &mut out).unwrap();
        for i in (0..out.len()).step_by(4) {
            assert_eq!(out[i], out[i + 1], "grayscale should run last");
            assert_eq!(out[i + 1], out[i + 2]);
        }
    }
}

#[cfg(test)]
mod all_filters_tests {
    use super::*;

    fn frame(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                // Something with edges, gradients and flat areas.
                let circle = if ((x as i32 - 40).pow(2) + (y as i32 - 30).pow(2)) < 400 { 220 } else { 30 };
                v.push(((x * 255) / w) as u8);
                v.push(circle as u8);
                v.push(((y * 255) / h) as u8);
                v.push(255);
            }
        }
        v
    }

    /// Every shader must compile and give a frame that is neither unchanged
    /// nor uniformly flat, which catches a shader that silently does nothing.
    #[test]
    fn every_filter_compiles_and_changes_the_picture() {
        let mut gpu = FilterGpu::new().unwrap();
        let (w, h) = (96u32, 64u32);
        let input = frame(w, h);

        for name in available_filters() {
            let spec = FilterSpec { name: name.clone(), params: HashMap::new() };
            let mut out = Vec::new();
            gpu.process(&input, w, h, std::slice::from_ref(&spec), &mut out)
                .unwrap_or_else(|e| panic!("{name} failed: {e}"));
            assert_eq!(out.len(), input.len(), "{name} returned the wrong size");

            let changed = out.iter().zip(input.iter()).any(|(a, b)| a != b);
            assert!(changed, "{name} left the frame untouched");

            let first = &out[0..3];
            let flat = out.chunks_exact(4).all(|p| p[0..3] == *first);
            assert!(!flat, "{name} produced a flat frame");

            assert!(out.chunks_exact(4).all(|p| p[3] == 255), "{name} broke alpha");
        }
    }

    /// Painting's first pass feeds its second; if the aux texture were not
    /// wired up the result would collapse to a plain directional blur.
    #[test]
    fn painting_uses_its_edge_pass() {
        let mut gpu = FilterGpu::new().unwrap();
        let (w, h) = (96u32, 64u32);
        let input = frame(w, h);

        let mut painting = Vec::new();
        gpu.process(&input, w, h,
                    &[FilterSpec { name: "Painting".into(), params: HashMap::new() }],
                    &mut painting).unwrap();

        // The edge pass on its own looks nothing like the finished filter.
        let mut edges = Vec::new();
        gpu.process(&input, w, h,
                    &[FilterSpec { name: "Painting.edge".into(), params: HashMap::new() }],
                    &mut edges).unwrap();

        let differing = painting.iter().zip(edges.iter()).filter(|(a, b)| a != b).count();
        assert!(differing > painting.len() / 10,
                "painting output looks like its edge pass ({differing} of {} bytes differ)", painting.len());
    }

    /// Monet's radius is compiled in, so two radii must give two pipelines
    /// and two different results.
    #[test]
    fn monet_radius_recompiles_and_takes_effect() {
        let mut gpu = FilterGpu::new().unwrap();
        let (w, h) = (96u32, 64u32);
        let input = frame(w, h);
        let run = |gpu: &mut FilterGpu, r: f32| {
            let mut out = Vec::new();
            let mut params = HashMap::new();
            params.insert("radius".to_string(), r);
            gpu.process(&input, w, h, &[FilterSpec { name: "Monet".into(), params }], &mut out).unwrap();
            out
        };
        let small = run(&mut gpu, 2.0);
        let large = run(&mut gpu, 8.0);
        assert_ne!(small, large, "changing Monet's radius did nothing");
    }
}

/// Applies a chain to a raw RGBA file. Used by the demo test and handy for
/// checking a port against 360mash by eye.
#[cfg(test)]
fn filter_raw_file(input: &str, output: &str, w: u32, h: u32, chain: &[FilterSpec]) {
    let data = std::fs::read(input).expect("raw input");
    let mut gpu = FilterGpu::new().unwrap();
    let mut out = Vec::new();
    gpu.process(&data, w, h, chain, &mut out).unwrap();
    std::fs::write(output, &out).unwrap();
}

#[cfg(test)]
mod demo {
    use super::*;

    /// Writes one processed frame per filter, when pointed at a raw RGBA file
    /// via BUBBLECUT_DEMO_DIR. Skipped otherwise.
    #[test]
    fn render_demo_frames() {
        let Ok(dir) = std::env::var("BUBBLECUT_DEMO_DIR") else { return };
        let w: u32 = std::env::var("BUBBLECUT_DEMO_W").unwrap().parse().unwrap();
        let h: u32 = std::env::var("BUBBLECUT_DEMO_H").unwrap().parse().unwrap();
        for name in available_filters() {
            let spec = FilterSpec { name: name.clone(), params: HashMap::new() };
            let safe = name.replace(' ', "_");
            filter_raw_file(
                &format!("{dir}/in.raw"),
                &format!("{dir}/out_{safe}.raw"),
                w, h,
                std::slice::from_ref(&spec),
            );
            println!("wrote {safe}");
        }
    }
}
