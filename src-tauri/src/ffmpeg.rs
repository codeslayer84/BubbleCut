//! Everything that shells out to ffmpeg / ffprobe.
//!
//! The export pipeline is one ffmpeg invocation: every clip is trimmed and
//! (optionally) reoriented with `v360`, the pieces are joined with `concat`,
//! and the result is encoded. Spherical metadata is injected afterwards by
//! `spherical.rs` because ffmpeg has no CLI switch for writing it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum FfError {
    #[error("{0} not found. Install ffmpeg (e.g. `brew install ffmpeg`) or set BUBBLECUT_FFMPEG_DIR.")]
    NotFound(&'static str),
    #[error("ffprobe failed: {0}")]
    Probe(String),
    #[error("ffmpeg failed (exit {code}):\n{log}")]
    Failed { code: i32, log: String },
    #[error("export cancelled")]
    Cancelled,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

/// The host's CPU architecture, named the way Mach-O headers name it.
pub fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

/// Locate an ffmpeg-family binary. GUI apps on macOS don't inherit the shell
/// PATH, so we also look in the usual package-manager locations.
///
/// A binary that must run under emulation loses access to the hardware video
/// encoders and is roughly 20x slower, so a native build always wins over an
/// emulated one no matter where it sits on PATH.
pub fn find_binary(name: &'static str) -> Result<PathBuf, FfError> {
    if let Ok(dir) = std::env::var("BUBBLECUT_FFMPEG_DIR") {
        let p = Path::new(&dir).join(name);
        if p.is_file() {
            return Ok(p);
        }
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
    ] {
        dirs.push(PathBuf::from(extra));
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".local/bin"));
    }

    let mut first: Option<PathBuf> = None;
    for d in dirs {
        let p = d.join(name);
        if !p.is_file() {
            continue;
        }
        let archs = binary_archs(&p);
        // Unknown architecture (not a Mach-O, e.g. a shell wrapper) is taken
        // at face value rather than skipped.
        if archs.is_empty() || archs.iter().any(|a| a == host_arch()) {
            return Ok(p);
        }
        first.get_or_insert(p);
    }
    first.ok_or(FfError::NotFound(name))
}

// ---------------------------------------------------------------- probing --

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum StereoMode {
    Mono,
    TopBottom,
    LeftRight,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub kind: MediaKind,
    pub path: String,
    pub name: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub audio_channels: u32,
    pub has_audio: bool,
    pub file_size: u64,
    /// `true` when the container already carries spherical (360) metadata.
    pub tagged_spherical: bool,
    pub stereo_mode: StereoMode,
    /// Whether stereo mode came from metadata or was guessed from aspect ratio.
    pub stereo_guessed: bool,
}

#[derive(Deserialize)]
struct ProbeOut {
    streams: Vec<ProbeStream>,
    format: ProbeFormat,
}
#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}
#[derive(Deserialize)]
struct ProbeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    channels: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    #[serde(default)]
    side_data_list: Vec<HashMap<String, serde_json::Value>>,
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn parse_rate(s: &str) -> f64 {
    let mut it = s.split('/');
    let n: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let d: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    if d == 0.0 {
        0.0
    } else {
        n / d
    }
}

pub fn probe_json(path: &str) -> Result<serde_json::Value, FfError> {
    let ffprobe = find_binary("ffprobe")?;
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()?;
    if !out.status.success() {
        return Err(FfError::Probe(String::from_utf8_lossy(&out.stderr).into()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| FfError::Probe(e.to_string()))
}

/// Video or audio-only. Music and narration live in the same media bin as the
/// footage, so one probe has to answer for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
}

/// Peak envelope for drawing a waveform: `buckets` values in 0..=1, each the
/// loudest sample in its slice of the file.
///
/// Decoded to mono 4 kHz because this is only ever a few hundred pixels wide —
/// at 48 kHz we would throw away 92% of what we decoded.
pub fn audio_peaks(path: &str, buckets: usize) -> Result<Vec<f32>, FfError> {
    use std::io::Read;
    let buckets = buckets.clamp(1, 20_000);
    const RATE: usize = 4000;

    let ffmpeg = find_binary("ffmpeg")?;
    let mut child = Command::new(ffmpeg)
        .args(["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar"])
        .arg(RATE.to_string())
        .args(["-f", "s16le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut raw = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| FfError::Probe("no ffmpeg stdout".into()))?
        .read_to_end(&mut raw)?;
    let status = child.wait()?;
    if !status.success() {
        return Err(FfError::Probe(format!("ffmpeg could not decode {path}")));
    }

    let samples: Vec<i16> = raw
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    if samples.is_empty() {
        return Ok(vec![0.0; buckets]);
    }

    // Peak rather than RMS: a waveform is read for where the sound *is*, and
    // RMS flattens transients into a sausage.
    let mut out = Vec::with_capacity(buckets);
    for i in 0..buckets {
        let lo = i * samples.len() / buckets;
        let hi = (((i + 1) * samples.len() / buckets).max(lo + 1)).min(samples.len());
        let peak = samples[lo..hi]
            .iter()
            .map(|v| (*v as f32 / i16::MAX as f32).abs())
            .fold(0.0f32, f32::max);
        out.push(peak.min(1.0));
    }
    Ok(out)
}

pub fn probe(path: &str) -> Result<MediaInfo, FfError> {
    let raw = probe_json(path)?;
    let p: ProbeOut = serde_json::from_value(raw).map_err(|e| FfError::Probe(e.to_string()))?;
    let audio = p.streams.iter().find(|s| s.codec_type == "audio");
    let Some(video) = p.streams.iter().find(|s| s.codec_type == "video") else {
        // Music or narration: no picture, so most of the fields below have
        // nothing to say.
        let audio = audio.ok_or_else(|| FfError::Probe("no video or audio stream".into()))?;
        let duration = p
            .format
            .duration
            .as_deref()
            .and_then(|d| d.parse().ok())
            .or_else(|| audio.duration.as_deref().and_then(|d| d.parse().ok()))
            .unwrap_or(0.0);
        return Ok(MediaInfo {
            kind: MediaKind::Audio,
            path: path.to_string(),
            name: file_name(path),
            duration,
            width: 0,
            height: 0,
            fps: 0.0,
            video_codec: String::new(),
            audio_codec: audio.codec_name.clone(),
            audio_channels: audio.channels.unwrap_or(2),
            has_audio: true,
            file_size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            tagged_spherical: false,
            stereo_mode: StereoMode::Mono,
            stereo_guessed: false,
        });
    };

    let width = video.width.unwrap_or(0);
    let height = video.height.unwrap_or(0);
    let fps = video
        .avg_frame_rate
        .as_deref()
        .map(parse_rate)
        .filter(|f| *f > 0.0)
        .or_else(|| video.r_frame_rate.as_deref().map(parse_rate))
        .unwrap_or(30.0);
    let duration = p
        .format
        .duration
        .as_deref()
        .and_then(|d| d.parse().ok())
        .or_else(|| video.duration.as_deref().and_then(|d| d.parse().ok()))
        .unwrap_or(0.0);

    // Existing metadata (ffprobe exposes st3d/sv3d as side data).
    let mut tagged_spherical = false;
    let mut stereo: Option<StereoMode> = None;
    for sd in &video.side_data_list {
        let ty = sd
            .get("side_data_type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if ty == "Spherical Mapping" {
            tagged_spherical = true;
        }
        if ty == "Stereo 3D" {
            stereo = match sd.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "top and bottom" => Some(StereoMode::TopBottom),
                "side by side" => Some(StereoMode::LeftRight),
                "2D" => Some(StereoMode::Mono),
                _ => None,
            };
        }
    }
    // Aspect-ratio heuristic: mono equirect is 2:1, TB stereo 1:1, SBS 4:1.
    let stereo_guessed = stereo.is_none();
    let stereo_mode = stereo.unwrap_or_else(|| {
        let ar = if height > 0 { width as f64 / height as f64 } else { 2.0 };
        if (ar - 1.0).abs() < 0.15 {
            StereoMode::TopBottom
        } else if (ar - 4.0).abs() < 0.3 {
            StereoMode::LeftRight
        } else {
            StereoMode::Mono
        }
    });

    Ok(MediaInfo {
        kind: MediaKind::Video,
        name: file_name(path),
        path: path.to_string(),
        duration,
        width,
        height,
        fps,
        video_codec: video.codec_name.clone().unwrap_or_default(),
        audio_codec: audio.and_then(|a| a.codec_name.clone()),
        audio_channels: audio.and_then(|a| a.channels).unwrap_or(0),
        has_audio: audio.is_some(),
        file_size: p.format.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
        tagged_spherical,
        stereo_mode,
        stereo_guessed,
    })
}

/// Names of video encoders this ffmpeg build offers, filtered to ones we use.
pub fn available_encoders() -> Result<Vec<String>, FfError> {
    let ffmpeg = find_binary("ffmpeg")?;
    let out = Command::new(ffmpeg).args(["-hide_banner", "-encoders"]).output()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let wanted = [
        "h264_videotoolbox",
        "hevc_videotoolbox",
        "libx264",
        "libx265",
        "h264_nvenc",
        "hevc_nvenc",
        "libsvtav1",
        "libaom-av1",
    ];
    Ok(wanted
        .iter()
        .filter(|w| text.lines().any(|l| l.split_whitespace().nth(1) == Some(w)))
        .map(|s| s.to_string())
        .collect())
}

/// CPU architectures a Mach-O binary contains ("arm64", "x86_64").
///
/// An x86_64-only ffmpeg on an Apple Silicon Mac runs under Rosetta, where it
/// cannot reach the hardware video encoders — the difference is dramatic, so
/// it is worth telling the user about.
pub fn binary_archs(path: &Path) -> Vec<String> {
    let Ok(d) = std::fs::read(path) else { return vec![] };
    if d.len() < 8 {
        return vec![];
    }
    let name = |cputype: u32| match cputype {
        0x0100_000c => Some("arm64".to_string()),
        0x0100_0007 => Some("x86_64".to_string()),
        _ => None,
    };
    let be32 = |o: usize| u32::from_be_bytes(d[o..o + 4].try_into().unwrap());
    let le32 = |o: usize| u32::from_le_bytes(d[o..o + 4].try_into().unwrap());

    match be32(0) {
        // Universal ("fat") binary: a table of per-architecture slices.
        0xcafe_babe => {
            let n = be32(4) as usize;
            (0..n)
                .filter_map(|i| {
                    let o = 8 + i * 20;
                    (o + 4 <= d.len()).then(|| name(be32(o))).flatten()
                })
                .collect()
        }
        _ => match le32(0) {
            0xfeed_facf | 0xfeed_face => name(le32(4)).into_iter().collect(),
            _ => vec![],
        },
    }
}

pub fn version() -> Result<String, FfError> {
    let ffmpeg = find_binary("ffmpeg")?;
    let out = Command::new(&ffmpeg).arg("-version").output()?;
    let first = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    Ok(format!("{} ({})", first, ffmpeg.display()))
}

// --------------------------------------------------------------- exporting --

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    pub path: String,
    pub in_point: f64,
    pub out_point: f64,
    /// Degrees. Applied with the `v360` filter when non-zero.
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    pub has_audio: bool,
    pub stereo_mode: StereoMode,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// A generated block of colour instead of a file: a title card.
    #[serde(default)]
    pub fill_color: Option<String>,
}

/// A text card burned into the exported video. The PNG is rendered by the UI
/// so that the preview and the export are pixel-identical.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCard {
    pub png_base64: String,
    pub png_width: u32,
    pub png_height: u32,
    pub start: f64,
    pub end: f64,
    pub yaw: f64,
    pub pitch: f64,
    pub roll: f64,
    /// Horizontal angular size of the card in degrees.
    pub width_deg: f64,
    /// Seconds to fade up / down. 0 means a hard cut.
    pub fade_in: f64,
    pub fade_out: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output: String,
    /// ffmpeg encoder name, e.g. `hevc_videotoolbox`.
    pub encoder: String,
    /// 0 = keep source size.
    pub width: u32,
    pub height: u32,
    /// 0 = keep source frame rate.
    pub fps: f64,
    pub video_bitrate_mbps: f64,
    pub audio_bitrate_kbps: u32,
    pub stereo_mode: StereoMode,
    pub faststart: bool,
    pub inject_spherical: bool,
}

pub struct ExportPlan {
    pub args: Vec<String>,
    pub total_duration: f64,
    /// Temporary PNGs written for text cards; deleted after the run.
    pub temp_files: Vec<PathBuf>,
}

/// Vertical FOV of a rectilinear card, from its horizontal FOV and aspect.
fn vertical_fov(h_fov: f64, w: u32, h: u32) -> f64 {
    let hr = h_fov.to_radians();
    (2.0 * ((hr / 2.0).tan() * (h as f64 / w as f64)).atan()).to_degrees()
}

/// Pixel size of the exported frame, needed to project cards at the right size.
fn output_size(clips: &[ExportClip], s: &ExportSettings) -> (u32, u32) {
    if s.width > 0 && s.height > 0 {
        return (s.width, s.height);
    }
    let c = &clips[0];
    // Reduce to a single eye, then re-apply the target layout.
    let (ew, eh) = match c.stereo_mode {
        StereoMode::Mono => (c.width, c.height),
        StereoMode::TopBottom => (c.width, c.height / 2),
        StereoMode::LeftRight => (c.width / 2, c.height),
    };
    match s.stereo_mode {
        StereoMode::Mono => (ew, eh),
        StereoMode::TopBottom => (ew, eh * 2),
        StereoMode::LeftRight => (ew * 2, eh),
    }
}

fn stereo_arg(m: &StereoMode) -> &'static str {
    match m {
        StereoMode::Mono => "2d",
        StereoMode::TopBottom => "tb",
        StereoMode::LeftRight => "sbs",
    }
}

fn fmt(f: f64) -> String {
    format!("{:.6}", f)
}


/// How one clip is fed to ffmpeg: a file seeked to its in point, or a
/// generated block of colour for a title card.
fn clip_input_args(c: &ExportClip) -> Vec<String> {
    match &c.fill_color {
        Some(colour) => {
            // Generated at the clip's own size and rate; the per-clip chain
            // then scales it like anything else, so it matches the footage.
            let (w, h) = (c.width.max(2), c.height.max(2));
            let rate = c.fps.max(1.0);
            let len = (c.out_point - c.in_point).max(0.0);
            vec![
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("color=c={colour}:s={w}x{h}:r={rate}:d={:.4}", len),
            ]
        }
        None => vec!["-ss".into(), fmt(c.in_point), "-i".into(), c.path.clone()],
    }
}

/// The per-clip video chain: trim, optional reorientation, resize, frame rate.
/// `out_format` is the pixel format the chain ends in, which differs between
/// the encode path (yuv420p) and the GPU path (rgba, to keep full chroma).
fn clip_video_chain(i: usize, c: &ExportClip, s: &ExportSettings, out_format: &str) -> String {
    let len = (c.out_point - c.in_point).max(0.0);
    let mut v = vec![format!("[{i}:v]trim=end={},setpts=PTS-STARTPTS", fmt(len))];
    if c.yaw != 0.0 || c.pitch != 0.0 || c.roll != 0.0 || c.stereo_mode != s.stereo_mode {
        v.push(format!(
            "v360=input=e:output=e:in_stereo={}:out_stereo={}:yaw={}:pitch={}:roll={}:interp=cubic",
            stereo_arg(&c.stereo_mode),
            stereo_arg(&s.stereo_mode),
            c.yaw,
            c.pitch,
            c.roll
        ));
    }
    if s.width > 0 && s.height > 0 {
        v.push(format!("scale={}:{}:flags=lanczos", s.width, s.height));
    }
    if s.fps > 0.0 {
        v.push(format!("fps={}", s.fps));
    }
    v.push(format!("format={out_format}"));
    format!("{}[v{i}]", v.join(","))
}

/// A video-only pass that ends in raw RGBA frames on stdout, for the GPU.
pub fn build_video_decode_args(clips: &[ExportClip], s: &ExportSettings) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into(), "-y".into()];
    for c in clips {
        args.extend(clip_input_args(c));
    }

    let mut graph: Vec<String> = Vec::new();
    let mut labels = String::new();
    for (i, c) in clips.iter().enumerate() {
        graph.push(clip_video_chain(i, c, s, "rgba"));
        labels.push_str(&format!("[v{i}]"));
    }
    graph.push(format!("{labels}concat=n={}:v=1:a=0[vcat]", clips.len()));

    args.extend(["-filter_complex".into(), graph.join(";")]);
    args.extend([
        "-map".into(), "[vcat]".into(),
        "-an".into(),
        "-f".into(), "rawvideo".into(),
        "-pix_fmt".into(), "rgba".into(),
        "-".into(),
    ]);
    args
}

/// Music or narration laid over the joined clip audio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudio {
    pub path: String,
    /// Seconds along the finished timeline.
    pub start: f64,
    pub in_point: f64,
    pub out_point: f64,
    /// Linear; 1.0 leaves the file as it is.
    pub gain: f64,
    pub fade_in: f64,
    pub fade_out: f64,
}

/// Inputs and graph for the audio tracks, mixed over `into` — the label
/// carrying the clips' own sound. Shared by the plain and the filtered export
/// so the two cannot drift apart.
///
/// Returns extra ffmpeg inputs, extra graph parts, and the label to map.
pub fn audio_mix_parts(
    tracks: &[ExportAudio],
    first_input_index: usize,
    into: &str,
) -> (Vec<String>, Vec<String>, String) {
    if tracks.is_empty() {
        return (Vec::new(), Vec::new(), into.to_string());
    }
    let mut args: Vec<String> = Vec::new();
    let mut graph: Vec<String> = Vec::new();
    let mut labels = format!("[{into}]");

    for (i, t) in tracks.iter().enumerate() {
        args.extend(["-ss".into(), fmt(t.in_point), "-i".into(), t.path.clone()]);
        let len = (t.out_point - t.in_point).max(0.0);
        let mut chain = format!(
            "[{}:a]atrim=end={},asetpts=PTS-STARTPTS,\
aformat=sample_rates=48000:channel_layouts=stereo",
            first_input_index + i,
            fmt(len)
        );
        if (t.gain - 1.0).abs() > 1e-6 {
            chain.push_str(&format!(",volume={:.4}", t.gain.max(0.0)));
        }
        if t.fade_in > 0.0 {
            chain.push_str(&format!(",afade=t=in:st=0:d={}", fmt(t.fade_in.min(len))));
        }
        if t.fade_out > 0.0 {
            let d = t.fade_out.min(len);
            chain.push_str(&format!(
                ",afade=t=out:st={}:d={}",
                fmt((len - d).max(0.0)),
                fmt(d)
            ));
        }
        if t.start > 0.0 {
            // adelay counts in milliseconds; all=1 saves repeating the figure
            // once per channel.
            chain.push_str(&format!(",adelay={}:all=1", (t.start * 1000.0).round() as i64));
        }
        chain.push_str(&format!("[m{i}]"));
        graph.push(chain);
        labels.push_str(&format!("[m{i}]"));
    }

    // normalize=0 because amix otherwise divides by the number of inputs, so
    // laying quiet music under the footage would halve the footage.
    // duration=first keeps the output as long as the timeline, whatever the
    // music does.
    graph.push(format!(
        "{labels}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[amixed]",
        tracks.len() + 1
    ));
    (args, graph, "amixed".to_string())
}

/// An audio-only pass over the same clips. Used by the filtered export, where
/// the audio has to be finished on disk before the encoder opens it.
pub fn build_audio_args(clips: &[ExportClip], tracks: &[ExportAudio], out: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into(), "-y".into()];
    for c in clips {
        args.extend(clip_input_args(c));
    }
    let silence_idx = clips.len();
    let any_silent = clips.iter().any(|c| !c.has_audio);
    if any_silent {
        args.extend([
            "-f".into(), "lavfi".into(), "-i".into(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
        ]);
    }

    let mut graph: Vec<String> = Vec::new();
    let mut labels = String::new();
    for (i, c) in clips.iter().enumerate() {
        let len = (c.out_point - c.in_point).max(0.0);
        let src = if c.has_audio { i } else { silence_idx };
        graph.push(format!(
            "[{src}:a]atrim=end={},asetpts=PTS-STARTPTS,aformat=sample_rates=48000[a{i}]",
            fmt(len)
        ));
        labels.push_str(&format!("[a{i}]"));
    }
    graph.push(format!("{labels}concat=n={}:v=0:a=1[aout]", clips.len()));

    let (mix_args, mix_graph, aout) =
        audio_mix_parts(tracks, clips.len() + usize::from(any_silent), "aout");
    args.extend(mix_args);
    graph.extend(mix_graph);

    args.extend(["-filter_complex".into(), graph.join(";")]);
    args.extend(["-map".into(), format!("[{aout}]"), "-c:a".into(), "pcm_s16le".into()]);
    args.push(out.to_string_lossy().into_owned());
    args
}

/// Writes each card's PNG next to the output so ffmpeg can read it.
pub fn write_card_pngs(cards: &[ExportCard], tmp_output: &Path) -> Result<Vec<PathBuf>, FfError> {
    let mut files = Vec::new();
    for (i, card) in cards.iter().enumerate() {
        let png = tmp_output.with_file_name(format!(
            ".{}.card{}.png",
            tmp_output.file_stem().map(|s| s.to_string_lossy()).unwrap_or_default(),
            i
        ));
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &card.png_base64)
            .map_err(|e| FfError::Other(format!("card {i}: bad PNG data: {e}")))?;
        std::fs::write(&png, bytes)?;
        files.push(png);
    }
    Ok(files)
}

/// The card half of the filter graph, shared by the plain and the filtered
/// export so the two cannot drift apart. Returns the graph parts and the
/// label carrying the result.
pub fn card_graph_parts(
    cards: &[ExportCard],
    s: &ExportSettings,
    out_w: u32,
    out_h: u32,
    first_input_index: usize,
    start_label: &str,
    fps: f64,
) -> (Vec<String>, String) {
    let mut graph: Vec<String> = Vec::new();
    // Text cards: project each flat card onto the sphere and overlay it.
    //
    // v360 discards the input alpha channel, so the alpha plane is extracted
    // and projected separately with identical parameters, then merged back.
    // v360's rotations are the opposite sign to ours, hence the negation.
    let (eye_w, eye_h) = match s.stereo_mode {
        StereoMode::Mono => (out_w, out_h),
        StereoMode::TopBottom => (out_w, out_h / 2),
        StereoMode::LeftRight => (out_w / 2, out_h),
    };
    let mut last = start_label.to_string();
    for (i, card) in cards.iter().enumerate() {
        let idx = first_input_index + i;
        let v360 = format!(
            "v360=flat:e:ih_fov={:.4}:iv_fov={:.4}:yaw={:.4}:pitch={:.4}:roll={:.4}:w={}:h={}:interp=cubic",
            card.width_deg,
            vertical_fov(card.width_deg, card.png_width, card.png_height),
            -card.yaw,
            -card.pitch,
            -card.roll,
            eye_w,
            eye_h
        );
        graph.push(format!("[{idx}:v]format=rgba,split[cr{i}][ca{i}]"));
        graph.push(format!("[ca{i}]alphaextract,format=gray,{v360}[cam{i}]"));
        graph.push(format!("[cr{i}]format=rgb24,{v360},format=rgba[crp{i}]"));
        graph.push(format!("[crp{i}][cam{i}]alphamerge[card{i}]"));
        // Both eyes get the same card (zero disparity = at infinity).
        // A still image is a single frame, which temporal filters cannot
        // animate. Rather than re-projecting every frame (costly at 8K), the
        // projection is done once and the frame replicated, then faded.
        let faded = if card.fade_in > 0.0 || card.fade_out > 0.0 {
            let rate = fps;
            let mut chain = format!("loop=loop=-1:size=1,setpts=N/({rate:.4}*TB)");
            if card.fade_in > 0.0 {
                chain.push_str(&format!(
                    ",fade=t=in:st={:.4}:d={:.4}:alpha=1",
                    card.start, card.fade_in
                ));
            }
            if card.fade_out > 0.0 {
                chain.push_str(&format!(
                    ",fade=t=out:st={:.4}:d={:.4}:alpha=1",
                    (card.end - card.fade_out).max(card.start),
                    card.fade_out
                ));
            }
            graph.push(format!("[card{i}]{chain}[cardt{i}]"));
            format!("cardt{i}")
        } else {
            format!("card{i}")
        };

        let card_label = match s.stereo_mode {
            StereoMode::Mono => faded.clone(),
            StereoMode::TopBottom => {
                graph.push(format!("[{faded}]split[c{i}a][c{i}b]"));
                graph.push(format!("[c{i}a][c{i}b]vstack[cardf{i}]"));
                format!("cardf{i}")
            }
            StereoMode::LeftRight => {
                graph.push(format!("[{faded}]split[c{i}a][c{i}b]"));
                graph.push(format!("[c{i}a][c{i}b]hstack[cardf{i}]"));
                format!("cardf{i}")
            }
        };
        let next = format!("ov{i}");
        graph.push(format!(
            "[{last}][{card_label}]overlay=0:0:eof_action=repeat:enable='between(t,{:.4},{:.4})'[{next}]",
            card.start, card.end
        ));
        last = next;
    }


    (graph, last)
}

/// Build the ffmpeg argument list for a sequence of clips.
/// Video size the decode stage emits, which the GPU and encoder must agree on.
pub fn frame_size(clips: &[ExportClip], s: &ExportSettings) -> (u32, u32) {
    output_size(clips, s)
}

/// Frame rate of the exported video.
pub fn frame_rate(clips: &[ExportClip], s: &ExportSettings) -> f64 {
    if s.fps > 0.0 { s.fps } else { clips.first().map(|c| c.fps).unwrap_or(30.0).max(1.0) }
}

pub fn build_plan(
    clips: &[ExportClip],
    cards: &[ExportCard],
    tracks: &[ExportAudio],
    s: &ExportSettings,
    tmp_output: &Path,
) -> Result<ExportPlan, FfError> {
    if clips.is_empty() {
        return Err(FfError::Other("timeline is empty".into()));
    }
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into(), "-y".into()];

    // Inputs. `-ss` before `-i` seeks fast on the demuxer; we then trim
    // precisely in the filter graph relative to the seeked position.
    for c in clips {
        args.extend(clip_input_args(c));
    }
    let silence_idx = clips.len();
    let any_silent = clips.iter().any(|c| !c.has_audio);
    if any_silent {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "anullsrc=channel_layout=stereo:sample_rate=48000".into(),
        ]);
    }

    // Card PNGs become extra inputs. A single still frame is enough: overlay
    // repeats it (eof_action=repeat) for as long as the main stream runs.
    let card_idx0 = clips.len() + if any_silent { 1 } else { 0 };
    let temp_files = write_card_pngs(cards, tmp_output)?;
    for png in &temp_files {
        args.extend(["-i".into(), png.to_string_lossy().into_owned()]);
    }

    let mut graph: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();
    let mut total = 0.0;
    for (i, c) in clips.iter().enumerate() {
        let len = (c.out_point - c.in_point).max(0.0);
        total += len;

        graph.push(clip_video_chain(i, c, s, "yuv420p"));

        let a_src = if c.has_audio { i } else { silence_idx };
        graph.push(format!(
            "[{a_src}:a]atrim=end={},asetpts=PTS-STARTPTS,aformat=sample_rates=48000[a{i}]",
            fmt(len)
        ));
        concat_inputs.push_str(&format!("[v{i}][a{i}]"));
    }
    graph.push(format!(
        "{concat_inputs}concat=n={}:v=1:a=1[vcat][aout]",
        clips.len()
    ));

    // Text cards are drawn on top of the joined video.
    let (out_w, out_h) = output_size(clips, s);
    let rate = frame_rate(clips, s);
    let (card_parts, last_label) =
        card_graph_parts(cards, s, out_w, out_h, card_idx0, "vcat", rate);
    graph.extend(card_parts);
    graph.push(format!("[{last_label}]format=yuv420p[vout]"));

    let (mix_args, mix_graph, aout) = audio_mix_parts(tracks, card_idx0 + cards.len(), "aout");
    args.extend(mix_args);
    graph.extend(mix_graph);

    args.extend(["-filter_complex".into(), graph.join(";")]);
    args.extend(["-map".into(), "[vout]".into(), "-map".into(), format!("[{aout}]")]);

    // Video encoder.
    args.extend(["-c:v".into(), s.encoder.clone()]);
    let kbps = (s.video_bitrate_mbps * 1000.0).round() as u64;
    match s.encoder.as_str() {
        "h264_videotoolbox" | "hevc_videotoolbox" => {
            args.extend([
                "-b:v".into(),
                format!("{kbps}k"),
                "-allow_sw".into(),
                "1".into(),
                "-realtime".into(),
                "0".into(),
            ]);
        }
        "libx264" | "libx265" => {
            args.extend([
                "-preset".into(),
                "medium".into(),
                "-b:v".into(),
                format!("{kbps}k"),
                "-maxrate".into(),
                format!("{}k", kbps * 3 / 2),
                "-bufsize".into(),
                format!("{}k", kbps * 2),
            ]);
        }
        _ => args.extend(["-b:v".into(), format!("{kbps}k")]),
    }
    if s.encoder.contains("hevc") || s.encoder.contains("x265") {
        // hvc1 tag is required for QuickTime / Apple players.
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }
    // Some VR players cope badly with very long GOPs; ~2s keyframe interval.
    let fps_for_gop = if s.fps > 0.0 { s.fps } else { 30.0 };
    args.extend(["-g".into(), format!("{}", (fps_for_gop * 2.0).round() as u32)]);

    // Audio: AAC keeps players happy; channel count is preserved by concat.
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{}k", s.audio_bitrate_kbps),
    ]);

    if s.faststart {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    // Card streams are looped indefinitely for fades, so bound the output
    // explicitly; without this ffmpeg would keep running past the last frame.
    args.extend(["-t".into(), fmt(total)]);
    args.extend(["-progress".into(), "pipe:1".into()]);
    args.push(tmp_output.to_string_lossy().into_owned());

    Ok(ExportPlan { args, total_duration: total, temp_files })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub percent: f64,
    pub out_time: f64,
    pub speed: String,
    pub fps: f64,
    pub stage: String,
}

/// Handles to the running ffmpeg children, so the UI can cancel. A filtered
/// export runs two of them with the GPU in between.
#[derive(Default, Clone)]
pub struct ExportHandle(pub Arc<Mutex<Vec<Child>>>);

impl ExportHandle {
    pub fn cancel(&self) -> bool {
        let mut children = self.0.lock().unwrap();
        let running = !children.is_empty();
        for child in children.iter_mut() {
            let _ = child.kill();
        }
        running
    }

    pub fn is_running(&self) -> bool {
        !self.0.lock().unwrap().is_empty()
    }

    pub fn take_all(&self) -> Vec<Child> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

/// Run ffmpeg, calling `on_progress` as it goes. Blocks the calling thread.
pub fn run(
    plan: &ExportPlan,
    handle: &ExportHandle,
    mut on_progress: impl FnMut(Progress),
) -> Result<(), FfError> {
    let ffmpeg = find_binary("ffmpeg")?;
    let mut child = Command::new(ffmpeg)
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    handle.0.lock().unwrap().push(child);

    // Drain stderr on its own thread so ffmpeg never blocks on a full pipe.
    let log = Arc::new(Mutex::new(String::new()));
    let log2 = log.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        *log2.lock().unwrap() = buf;
    });

    let total = plan.total_duration.max(0.001);
    let mut cur = Progress {
        percent: 0.0,
        out_time: 0.0,
        speed: String::new(),
        fps: 0.0,
        stage: "encoding".into(),
    };
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let Some((k, v)) = line.split_once('=') else { continue };
        match k.trim() {
            "out_time_us" | "out_time_ms" => {
                // Despite the name, ffmpeg writes microseconds for both keys.
                if let Ok(us) = v.trim().parse::<i64>() {
                    cur.out_time = (us.max(0) as f64) / 1_000_000.0;
                    cur.percent = (cur.out_time / total * 100.0).clamp(0.0, 99.9);
                }
            }
            "speed" => cur.speed = v.trim().to_string(),
            "fps" => cur.fps = v.trim().parse().unwrap_or(0.0),
            // `progress=continue|end` terminates each block.
            "progress" => on_progress(cur.clone()),
            _ => {}
        }
    }

    let status = {
        let mut children = handle.take_all();
        let mut child = children.pop().unwrap();
        child.wait()?
    };
    let _ = stderr_thread.join();
    let log = log.lock().unwrap().clone();

    if status.success() {
        Ok(())
    } else if status.code().is_none() {
        // Killed by signal → we cancelled it.
        Err(FfError::Cancelled)
    } else {
        let tail: Vec<&str> = log.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect();
        Err(FfError::Failed {
            code: status.code().unwrap_or(-1),
            log: tail.join("\n"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ffmpeg() -> PathBuf {
        find_binary("ffmpeg").expect("ffmpeg on PATH for tests")
    }

    fn gen(dir: &Path, name: &str, with_audio: bool, secs: u32) -> String {
        let p = dir.join(name);
        let mut c = Command::new(find_binary("ffmpeg").unwrap());
        c.args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size=640x320:rate=30:duration={secs}"));
        if with_audio {
            c.args(["-f", "lavfi", "-i"]).arg(format!("sine=frequency=440:duration={secs}"));
        }
        c.args(["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
        if with_audio {
            c.args(["-c:a", "aac"]);
        }
        assert!(c.arg(&p).status().unwrap().success());
        p.to_string_lossy().into_owned()
    }

    /// An opaque red bar on a transparent canvas, as a stand-in for a card.
    fn card_png_base64(dir: &Path) -> (String, u32, u32) {
        let p = dir.join("card.png");
        let status = Command::new(ffmpeg())
            .args([
                "-y", "-v", "error",
                "-f", "lavfi", "-i", "color=c=#00000000:s=400x200,format=rgba",
                "-f", "lavfi", "-i", "color=c=#ff0000:s=300x80,format=rgba",
                "-filter_complex", "[0][1]overlay=50:60,format=rgba", "-frames:v", "1",
            ])
            .arg(&p)
            .status()
            .unwrap();
        assert!(status.success());
        let bytes = std::fs::read(&p).unwrap();
        (
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
            400,
            200,
        )
    }

    /// A featureless clip, so any red pixel in the output must be the card.
    fn gen_plain(dir: &Path, name: &str, secs: u32) -> String {
        let p = dir.join(name);
        let status = Command::new(ffmpeg())
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("color=c=#203040:size=640x320:rate=30:duration={secs}"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={secs}"))
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&p)
            .status()
            .unwrap();
        assert!(status.success());
        p.to_string_lossy().into_owned()
    }

    /// Counts pixels close to pure red in a frame grabbed at `at` seconds.
    fn red_pixels(video: &str, at: f64) -> usize {
        let out = Command::new(ffmpeg())
            .args(["-v", "error", "-ss", &format!("{at}"), "-i", video, "-frames:v", "1",
                   "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        out.stdout
            .chunks_exact(3)
            .filter(|p| p[0] > 140 && p[1] < 90 && p[2] < 90)
            .count()
    }

    #[test]
    fn text_card_is_burned_in_only_during_its_time_range() {
        let dir = std::env::temp_dir().join(format!("bubblecut-card-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen_plain(&dir, "a.mp4", 6);
        let (png_base64, png_width, png_height) = card_png_base64(&dir);
        let clips = vec![ExportClip {
            path: src, in_point: 0.0, out_point: 6.0, yaw: 0.0, pitch: 0.0, roll: 0.0,
            has_audio: true, stereo_mode: StereoMode::Mono, width: 640, height: 320, fps: 30.0, fill_color: None,
        }];
        let cards = vec![ExportCard {
            png_base64, png_width, png_height,
            start: 2.0, end: 4.0,
            yaw: 0.0, pitch: 0.0, roll: 0.0, width_deg: 60.0, fade_in: 0.0, fade_out: 0.0,
        }];
        let settings = ExportSettings {
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: 1024, height: 512, fps: 30.0,
            video_bitrate_mbps: 8.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: true,
        };
        let tmp = dir.join("tmp.mp4");
        let plan = build_plan(&clips, &cards, &[], &settings, &tmp).unwrap();
        assert_eq!(plan.temp_files.len(), 1, "card PNG should be written to disk");
        run(&plan, &ExportHandle::default(), |_| {}).unwrap();

        let v = tmp.to_string_lossy().into_owned();
        let before = red_pixels(&v, 1.0);
        let during = red_pixels(&v, 3.0);
        let after = red_pixels(&v, 5.0);
        assert!(during > 2000, "card missing during its range (red px = {during})");
        assert!(before < 200, "card visible before its range (red px = {before})");
        assert!(after < 200, "card visible after its range (red px = {after})");

        // Temp PNGs are the caller's to clean up, but they must exist until then.
        for f in &plan.temp_files {
            assert!(f.exists());
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Bounding box of red pixels in a frame, as fractions of width/height.
    fn red_bbox(video: &str, at: f64, w: usize, h: usize) -> Option<(f64, f64, f64, f64)> {
        let out = Command::new(ffmpeg())
            .args(["-v", "error", "-ss", &format!("{at}"), "-i", video, "-frames:v", "1",
                   "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        let d = &out.stdout;
        let (mut x0, mut x1, mut y0, mut y1) = (usize::MAX, 0usize, usize::MAX, 0usize);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                if i + 2 < d.len() && d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 90 {
                    x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y);
                }
            }
        }
        if x0 == usize::MAX { return None; }
        Some((x0 as f64 / w as f64, x1 as f64 / w as f64, y0 as f64 / h as f64, y1 as f64 / h as f64))
    }

    /// The exported card must land where the preview's maths says it will:
    /// centred on its yaw/pitch and spanning `width_deg` of the sphere.
    #[test]
    fn card_geometry_matches_preview_maths() {
        let dir = std::env::temp_dir().join(format!("bubblecut-geom-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen_plain(&dir, "a.mp4", 3);
        // Card canvas is 400x200 with the red bar filling 300x80 centred in it,
        // so the bar spans 3/4 of the card's width.
        let (png_base64, png_width, png_height) = card_png_base64(&dir);
        const YAW: f64 = 45.0;
        const CARD_DEG: f64 = 40.0;
        // The clip is reoriented as well: cards live in the *output* frame, so
        // the clip's own yaw must not drag the card along with it.
        let clips = vec![ExportClip {
            path: src, in_point: 0.0, out_point: 3.0, yaw: 90.0, pitch: 0.0, roll: 0.0,
            has_audio: true, stereo_mode: StereoMode::Mono, width: 640, height: 320, fps: 30.0, fill_color: None,
        }];
        let cards = vec![ExportCard {
            png_base64, png_width, png_height,
            start: 0.0, end: 3.0, yaw: YAW, pitch: 0.0, roll: 0.0, width_deg: CARD_DEG, fade_in: 0.0, fade_out: 0.0,
        }];
        let (w, h) = (1024usize, 512usize);
        let settings = ExportSettings {
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: w as u32, height: h as u32, fps: 30.0,
            video_bitrate_mbps: 12.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: true,
        };
        let tmp = dir.join("tmp.mp4");
        let plan = build_plan(&clips, &cards, &[], &settings, &tmp).unwrap();
        run(&plan, &ExportHandle::default(), |_| {}).unwrap();

        let (x0, x1, y0, y1) = red_bbox(&tmp.to_string_lossy(), 1.5, w, h).expect("card not found");
        let centre_x = (x0 + x1) / 2.0;
        let expected_x = 0.5 + YAW / 360.0; // +yaw looks right => right of centre
        assert!((centre_x - expected_x).abs() < 0.01,
                "card centred at {centre_x:.3} of width, expected {expected_x:.3}");

        let centre_y = (y0 + y1) / 2.0;
        assert!((centre_y - 0.5).abs() < 0.01, "card should sit on the equator, got {centre_y:.3}");

        // The red bar covers 3/4 of the 40-degree card.
        let span_deg = (x1 - x0) * 360.0;
        let expected_span = CARD_DEG * 0.75;
        assert!((span_deg - expected_span).abs() < 2.0,
                "card spans {span_deg:.1} degrees, expected about {expected_span:.1}");

        for f in &plan.temp_files { let _ = std::fs::remove_file(f); }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Mean redness of the card region, as a proxy for its opacity.
    fn card_strength(video: &str, at: f64) -> u8 {
        let out = Command::new(ffmpeg())
            .args(["-v", "error", "-ss", &format!("{at}"), "-i", video, "-frames:v", "1",
                   "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap();
        out.stdout.chunks_exact(3).filter(|p| p[1] < 80 && p[2] < 90).map(|p| p[0]).max().unwrap_or(0)
    }

    #[test]
    fn card_fades_up_and_down() {
        let dir = std::env::temp_dir().join(format!("bubblecut-fade-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen_plain(&dir, "a.mp4", 8);
        let (png_base64, png_width, png_height) = card_png_base64(&dir);
        let clips = vec![ExportClip {
            path: src, in_point: 0.0, out_point: 8.0, yaw: 0.0, pitch: 0.0, roll: 0.0,
            has_audio: true, stereo_mode: StereoMode::Mono, width: 640, height: 320, fps: 30.0, fill_color: None,
        }];
        let cards = vec![ExportCard {
            png_base64, png_width, png_height,
            start: 2.0, end: 6.0, yaw: 0.0, pitch: 0.0, roll: 0.0, width_deg: 60.0,
            fade_in: 1.0, fade_out: 1.0,
        }];
        let settings = ExportSettings {
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: 1024, height: 512, fps: 30.0,
            video_bitrate_mbps: 12.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: true,
        };
        let tmp = dir.join("tmp.mp4");
        let plan = build_plan(&clips, &cards, &[], &settings, &tmp).unwrap();
        run(&plan, &ExportHandle::default(), |_| {}).unwrap();
        let v = tmp.to_string_lossy().into_owned();

        let before = card_strength(&v, 1.0);
        let rising = card_strength(&v, 2.5);
        let full = card_strength(&v, 4.0);
        let falling = card_strength(&v, 5.5);
        let after = card_strength(&v, 7.0);

        assert!(before < 60, "card showing before its range ({before})");
        assert!(after < 60, "card showing after its range ({after})");
        assert!(full > 180, "card never reaches full opacity ({full})");
        assert!(rising > before + 30 && rising < full - 30,
                "fade-in not ramping: before={before} rising={rising} full={full}");
        assert!(falling > after + 30 && falling < full - 30,
                "fade-out not ramping: full={full} falling={falling} after={after}");

        for f in &plan.temp_files { let _ = std::fs::remove_file(f); }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Ten seconds where each second is a distinct shade of grey, so the
    /// second any exported frame came from can be read back off the picture.
    fn gen_ramp(dir: &Path, secs: u32) -> String {
        let parts: Vec<PathBuf> = (0..secs)
            .map(|i| {
                let level = 20 + i * 22;
                let p = dir.join(format!("part{i}.mp4"));
                let colour = format!("color=c=0x{0:02x}{0:02x}{0:02x}:s=320x160:d=1:r=10", level);
                assert!(Command::new(ffmpeg())
                    .args(["-y", "-v", "error", "-f", "lavfi", "-i", &colour,
                           "-c:v", "libx264", "-pix_fmt", "yuv420p"])
                    .arg(&p).status().unwrap().success());
                p
            })
            .collect();

        let list = dir.join("list.txt");
        std::fs::write(&list, parts.iter()
            .map(|p| format!("file '{}'", p.display()))
            .collect::<Vec<_>>().join("\n")).unwrap();

        let out = dir.join("ramp.mp4");
        assert!(Command::new(ffmpeg())
            .args(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list)
            .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&out).status().unwrap().success());
        out.to_string_lossy().into_owned()
    }

    /// Which second of the ramp a frame came from.
    fn second_at(video: &str, at: f64) -> i32 {
        let out = Command::new(ffmpeg())
            .args(["-v", "error", "-ss", &format!("{at}"), "-i", video,
                   "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "-"])
            .output().unwrap().stdout;
        let mid = out[out.len() / 2] as i32;
        ((mid - 20) as f64 / 22.0).round() as i32
    }

    /// Exporting a range must contain exactly the chosen seconds. The clip is
    /// sliced the way the UI slices it for a selection: in and out points
    /// moved, nothing else changed.
    #[test]
    fn exporting_a_selection_keeps_only_the_chosen_range() {
        let dir = std::env::temp_dir().join(format!("bubblecut-sel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen_ramp(&dir, 10);

        // Sanity: the ramp really does step a shade per second.
        assert_eq!(second_at(&src, 0.5), 0, "ramp second 0");
        assert_eq!(second_at(&src, 6.5), 6, "ramp second 6");

        // Selection 3s..7s of a clip that spans the whole file.
        let clips = vec![ExportClip {
            path: src, in_point: 3.0, out_point: 7.0,
            yaw: 0.0, pitch: 0.0, roll: 0.0, has_audio: true,
            stereo_mode: StereoMode::Mono, width: 320, height: 160, fps: 10.0, fill_color: None,
        }];
        let out = dir.join("out.mp4");
        let tmp = dir.join("tmp.mp4");
        let settings = ExportSettings {
            output: out.to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: 320, height: 160, fps: 10.0,
            video_bitrate_mbps: 4.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: false,
        };
        let plan = build_plan(&clips, &[], &[], &settings, &tmp).unwrap();
        assert!((plan.total_duration - 4.0).abs() < 1e-6);
        run(&plan, &ExportHandle::default(), |_| {}).unwrap();

        let v = tmp.to_string_lossy().into_owned();
        let info = probe(&v).unwrap();
        assert!((info.duration - 4.0).abs() < 0.2, "duration {}", info.duration);

        // The four exported seconds must be the source's 3, 4, 5 and 6.
        for (offset, expected) in [(0.5, 3), (1.5, 4), (2.5, 5), (3.5, 6)] {
            let got = second_at(&v, offset);
            assert_eq!(got, expected,
                       "at {offset}s into the export we should see source second {expected}, saw {got}");
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A title card is a generated block of colour with no file behind it. It
    /// has to join the timeline like any other clip, silence included.
    #[test]
    fn a_title_clip_is_generated_not_read_from_a_file() {
        let dir = std::env::temp_dir().join(format!("bubblecut-title-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen_plain(&dir, "a.mp4", 2);

        let footage = ExportClip {
            path: src, in_point: 0.0, out_point: 2.0, yaw: 0.0, pitch: 0.0, roll: 0.0,
            has_audio: true, stereo_mode: StereoMode::Mono,
            width: 640, height: 320, fps: 30.0, fill_color: None,
        };
        let title = ExportClip {
            path: String::new(), in_point: 0.0, out_point: 1.5,
            yaw: 0.0, pitch: 0.0, roll: 0.0,
            has_audio: false, stereo_mode: StereoMode::Mono,
            width: 640, height: 320, fps: 30.0,
            fill_color: Some("#000000".into()),
        };

        let out = dir.join("out.mp4");
        let tmp = dir.join("tmp.mp4");
        let settings = ExportSettings {
            output: out.to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: 640, height: 320, fps: 30.0,
            video_bitrate_mbps: 4.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: false,
        };
        // Title first, then footage.
        let clips = vec![title, footage];
        let plan = build_plan(&clips, &[], &[], &settings, &tmp).unwrap();
        assert!((plan.total_duration - 3.5).abs() < 1e-6);
        run(&plan, &ExportHandle::default(), |_| {}).unwrap();

        let v = tmp.to_string_lossy().into_owned();
        let info = probe(&v).unwrap();
        assert!((info.duration - 3.5).abs() < 0.2, "duration {}", info.duration);
        assert!(info.has_audio, "the silent title must not lose the audio track");

        // The first second and a half is black, then the footage appears.
        let brightness = |at: f64| -> u8 {
            let o = Command::new(ffmpeg())
                .args(["-v", "error", "-ss", &format!("{at}"), "-i", &v, "-frames:v", "1",
                       "-pix_fmt", "gray", "-f", "rawvideo", "-"])
                .output().unwrap().stdout;
            o[o.len() / 2]
        };
        assert!(brightness(0.7) < 20, "title should be black, got {}", brightness(0.7));
        assert!(brightness(2.5) > 30, "footage should follow, got {}", brightness(2.5));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn export_two_clips_end_to_end() {
        let dir = std::env::temp_dir().join(format!("bubblecut-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = gen(&dir, "a.mp4", true, 4);
        let b = gen(&dir, "b.mp4", false, 4);
        let clips = vec![
            ExportClip { path: a, in_point: 1.0, out_point: 3.0, yaw: 90.0, pitch: 0.0, roll: 0.0, has_audio: true, stereo_mode: StereoMode::Mono, width: 640, height: 320, fps: 30.0, fill_color: None },
            ExportClip { path: b, in_point: 0.5, out_point: 2.0, yaw: 0.0, pitch: 0.0, roll: 0.0, has_audio: false, stereo_mode: StereoMode::Mono, width: 640, height: 320, fps: 30.0, fill_color: None },
        ];
        let encoders = available_encoders().unwrap();
        let encoder = if encoders.iter().any(|e| e == "libx264") { "libx264" } else { &encoders[0] }.to_string();
        let settings = ExportSettings {
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            encoder, width: 0, height: 0, fps: 0.0, video_bitrate_mbps: 2.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: true,
        };
        let tmp = dir.join("tmp.mp4");
        let plan = build_plan(&clips, &[], &[], &settings, &tmp).unwrap();
        assert!((plan.total_duration - 3.5).abs() < 1e-6);

        let handle = ExportHandle::default();
        let mut last = 0.0;
        run(&plan, &handle, |p| last = p.percent).unwrap();
        assert!(last > 50.0, "progress never reported: {last}");

        let out = Path::new(&settings.output);
        crate::spherical::inject(&tmp, out, &settings.stereo_mode).unwrap();
        let info = probe(&settings.output).unwrap();
        assert!((info.duration - 3.5).abs() < 0.15, "duration {}", info.duration);
        assert!(info.has_audio);
        assert!(info.tagged_spherical);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Mean volume of one window of a file's audio, in dBFS. -91 or so means
    /// digital silence.
    fn mean_db(path: &str, from: f64, to: f64) -> f64 {
        let out = Command::new(ffmpeg())
            .args(["-v", "info", "-ss", &format!("{from}"), "-t", &format!("{}", to - from)])
            .args(["-i", path, "-af", "volumedetect", "-f", "null", "-"])
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&out.stderr);
        log.lines()
            .find_map(|l| l.split("mean_volume:").nth(1))
            .and_then(|v| v.trim().split_whitespace().next())
            .and_then(|v| v.parse().ok())
            .unwrap_or(-100.0)
    }

    /// The point of the audio lane: a music file dropped at 2s has to be
    /// silent before 2s and audible after, mixed over whatever the clips are
    /// already doing. Asserting on the filter string would not catch adelay
    /// counting in the wrong unit, or amix halving everything.
    #[test]
    fn an_audio_track_lands_at_its_offset_on_the_timeline() {
        let dir = std::env::temp_dir().join(format!("bubblecut-aud-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        // Silent footage, so anything heard came from the track.
        let video = gen(&dir, "silent.mp4", false, 6);
        let music = dir.join("music.wav");
        assert!(
            Command::new(ffmpeg())
                .args(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:duration=2"])
                .arg(&music)
                .status()
                .unwrap()
                .success()
        );

        let clips = vec![ExportClip {
            path: video, in_point: 0.0, out_point: 6.0,
            yaw: 0.0, pitch: 0.0, roll: 0.0, has_audio: false,
            stereo_mode: StereoMode::Mono, width: 640, height: 320, fps: 30.0, fill_color: None,
        }];
        let tracks = vec![ExportAudio {
            path: music.to_string_lossy().into_owned(),
            start: 2.0, in_point: 0.0, out_point: 2.0,
            gain: 1.0, fade_in: 0.0, fade_out: 0.0,
        }];

        let out = dir.join("out.mp4");
        let settings = ExportSettings {
            output: out.to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: 640, height: 320, fps: 30.0,
            video_bitrate_mbps: 4.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: false,
        };
        let tmp = dir.join("tmp.mp4");
        let plan = build_plan(&clips, &[], &tracks, &settings, &tmp).unwrap();
        assert!(Command::new(ffmpeg()).args(&plan.args).status().unwrap().success());
        std::fs::rename(&tmp, &out).ok();

        let path = out.to_string_lossy().into_owned();
        let before = mean_db(&path, 0.2, 1.8);
        let during = mean_db(&path, 2.2, 3.8);
        let after = mean_db(&path, 4.2, 5.8);

        assert!(before < -60.0, "should be silent before the track: {before} dB");
        // A -18 dBFS sine lands near -21 dB RMS; the bar is set well below
        // that and well above the -60 the silence has to clear.
        assert!(during > -35.0, "the track should be audible at its offset: {during} dB");
        assert!(after < -60.0, "should be silent again once it ends: {after} dB");

        // The output must still run the full length of the footage, not stop
        // when the music does.
        let info = probe(&path).unwrap();
        assert!(info.duration > 5.5, "mix truncated the timeline: {}", info.duration);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Peaks have to follow the sound, or the waveform is decoration.
    #[test]
    fn peaks_are_loud_where_the_sound_is() {
        let dir = std::env::temp_dir().join(format!("bubblecut-pk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("halves.wav");
        // Two seconds of silence, then two of tone.
        assert!(
            Command::new(ffmpeg())
                .args(["-y", "-v", "error"])
                .args(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2"])
                .args(["-f", "lavfi", "-i", "sine=frequency=440:duration=2"])
                .args(["-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1"])
                .arg(&wav)
                .status()
                .unwrap()
                .success()
        );

        let peaks = audio_peaks(&wav.to_string_lossy(), 40).unwrap();
        assert_eq!(peaks.len(), 40);
        // ffmpeg's `sine` source runs at about 0.125 full scale, not unity, so
        // this asserts the contrast between the halves rather than a level.
        let quiet: f32 = peaks[2..18].iter().copied().fold(0.0, f32::max);
        let loud: f32 = peaks[22..38].iter().copied().fold(1.0, f32::min);
        assert!(quiet < 0.01, "first half should be silent, peaked {quiet}");
        assert!(loud > 0.05, "second half should carry the tone, quietest bucket {loud}");
        assert!(loud > quiet * 10.0, "no contrast between silence and tone");
        assert!(peaks.iter().all(|p| (0.0..=1.0).contains(p)));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
