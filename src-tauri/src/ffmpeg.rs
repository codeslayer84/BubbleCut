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
    #[error("{0} not found. Install ffmpeg (e.g. `brew install ffmpeg`) or set EDITOR360_FFMPEG_DIR.")]
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

/// Locate an ffmpeg-family binary. GUI apps on macOS don't inherit the shell
/// PATH, so we also look in the usual package-manager locations.
pub fn find_binary(name: &'static str) -> Result<PathBuf, FfError> {
    if let Ok(dir) = std::env::var("EDITOR360_FFMPEG_DIR") {
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
    for d in dirs {
        let p = d.join(name);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(FfError::NotFound(name))
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

pub fn probe(path: &str) -> Result<MediaInfo, FfError> {
    let raw = probe_json(path)?;
    let p: ProbeOut = serde_json::from_value(raw).map_err(|e| FfError::Probe(e.to_string()))?;
    let video = p
        .streams
        .iter()
        .find(|s| s.codec_type == "video")
        .ok_or_else(|| FfError::Probe("no video stream".into()))?;
    let audio = p.streams.iter().find(|s| s.codec_type == "audio");

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
        name: Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string()),
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

/// Build the ffmpeg argument list for a sequence of clips.
pub fn build_plan(clips: &[ExportClip], s: &ExportSettings, tmp_output: &Path) -> Result<ExportPlan, FfError> {
    if clips.is_empty() {
        return Err(FfError::Other("timeline is empty".into()));
    }
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into(), "-y".into()];

    // Inputs. `-ss` before `-i` seeks fast on the demuxer; we then trim
    // precisely in the filter graph relative to the seeked position.
    for c in clips {
        args.extend(["-ss".into(), fmt(c.in_point), "-i".into(), c.path.clone()]);
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

    let mut graph: Vec<String> = Vec::new();
    let mut concat_inputs = String::new();
    let mut total = 0.0;
    for (i, c) in clips.iter().enumerate() {
        let len = (c.out_point - c.in_point).max(0.0);
        total += len;

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
        v.push("format=yuv420p".into());
        graph.push(format!("{}[v{i}]", v.join(",")));

        let a_src = if c.has_audio { i } else { silence_idx };
        graph.push(format!(
            "[{a_src}:a]atrim=end={},asetpts=PTS-STARTPTS,aformat=sample_rates=48000[a{i}]",
            fmt(len)
        ));
        concat_inputs.push_str(&format!("[v{i}][a{i}]"));
    }
    graph.push(format!(
        "{concat_inputs}concat=n={}:v=1:a=1[vout][aout]",
        clips.len()
    ));

    args.extend(["-filter_complex".into(), graph.join(";")]);
    args.extend(["-map".into(), "[vout]".into(), "-map".into(), "[aout]".into()]);

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
    args.extend(["-progress".into(), "pipe:1".into()]);
    args.push(tmp_output.to_string_lossy().into_owned());

    Ok(ExportPlan { args, total_duration: total })
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

/// Handle to the running ffmpeg child, so the UI can cancel.
#[derive(Default, Clone)]
pub struct ExportHandle(pub Arc<Mutex<Option<Child>>>);

impl ExportHandle {
    pub fn cancel(&self) -> bool {
        if let Some(child) = self.0.lock().unwrap().as_mut() {
            let _ = child.kill();
            return true;
        }
        false
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
    *handle.0.lock().unwrap() = Some(child);

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
        let mut guard = handle.0.lock().unwrap();
        let mut child = guard.take().unwrap();
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

    #[test]
    fn export_two_clips_end_to_end() {
        let dir = std::env::temp_dir().join(format!("editor360-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = gen(&dir, "a.mp4", true, 4);
        let b = gen(&dir, "b.mp4", false, 4);
        let clips = vec![
            ExportClip { path: a, in_point: 1.0, out_point: 3.0, yaw: 90.0, pitch: 0.0, roll: 0.0, has_audio: true, stereo_mode: StereoMode::Mono },
            ExportClip { path: b, in_point: 0.5, out_point: 2.0, yaw: 0.0, pitch: 0.0, roll: 0.0, has_audio: false, stereo_mode: StereoMode::Mono },
        ];
        let encoders = available_encoders().unwrap();
        let encoder = if encoders.iter().any(|e| e == "libx264") { "libx264" } else { &encoders[0] }.to_string();
        let settings = ExportSettings {
            output: dir.join("out.mp4").to_string_lossy().into_owned(),
            encoder, width: 0, height: 0, fps: 0.0, video_bitrate_mbps: 2.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: true,
        };
        let tmp = dir.join("tmp.mp4");
        let plan = build_plan(&clips, &settings, &tmp).unwrap();
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
}
