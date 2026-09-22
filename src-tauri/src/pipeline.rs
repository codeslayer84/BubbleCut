//! Export with image filters applied.
//!
//! ffmpeg here has no GPU shader support (no libplacebo, OpenCL or Vulkan), so
//! the filters cannot live inside its filter graph. Instead the work is split:
//! ffmpeg decodes, trims, reorients and joins the clips; the frames pass
//! through the GPU; and a second ffmpeg burns in any text cards and encodes
//! with the hardware encoder.
//!
//! 360mash does the same shader work but then encodes with libav compiled to
//! WebAssembly, which is what makes it slow. Keeping ffmpeg on both ends is
//! the whole point of doing it this way.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::ffmpeg::{
    self, ExportCard, ExportClip, ExportHandle, ExportSettings, FfError, Progress,
};
use crate::gpufilters::{FilterGpu, FilterSpec};

/// Which frames belong to which clip, so each clip's own filters can be used.
/// The frames arrive as one concatenated stream, so this is just the clip
/// boundaries converted to frame numbers.
pub fn clip_frame_bounds(clips: &[ExportClip], fps: f64) -> Vec<u64> {
    let mut bounds = Vec::with_capacity(clips.len());
    let mut acc = 0.0;
    for c in clips {
        acc += (c.out_point - c.in_point).max(0.0);
        bounds.push((acc * fps).round() as u64);
    }
    bounds
}

pub struct FilteredPlan {
    /// Pulls the joined audio out first. It has to finish before the encoder
    /// starts, otherwise the encoder waits on a half-written file while the
    /// decoder waits for its video pipe to drain, and the two deadlock.
    pub audio_args: Vec<String>,
    pub decode_args: Vec<String>,
    pub encode_args: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub total_duration: f64,
    pub total_frames: u64,
    pub temp_files: Vec<PathBuf>,
    /// Frame index at which each clip ends.
    pub clip_bounds: Vec<u64>,
}

/// Builds the two ffmpeg commands that sit either side of the GPU.
pub fn build(
    clips: &[ExportClip],
    cards: &[ExportCard],
    s: &ExportSettings,
    tmp_output: &Path,
) -> Result<FilteredPlan, FfError> {
    // The video half is assembled from the same pieces the single-process
    // plan uses, so trimming, reorientation and card layout stay identical.
    let base = ffmpeg::build_plan(clips, &[], s, tmp_output)?;
    let (width, height) = ffmpeg::frame_size(clips, s);
    let fps = ffmpeg::frame_rate(clips, s);
    let audio_path = tmp_output.with_extension("audio.wav");

    // Decode: reuse the plan up to the joined video, swapping the encoder for
    // raw frames on stdout and a WAV of the joined audio.
    let cut = base
        .args
        .iter()
        .position(|a| a == "-c:v")
        .ok_or_else(|| FfError::Other("base plan has no encoder".into()))?;
    let audio_args = ffmpeg::build_audio_args(clips, &audio_path);
    let decode_args = ffmpeg::build_video_decode_args(clips, s);

    // Encode: raw frames in, cards on top of the filtered picture, then the
    // same encoder settings the single-process plan would have used.
    let card_pngs = ffmpeg::write_card_pngs(cards, tmp_output)?;
    let mut encode_args: Vec<String> = vec![
        "-hide_banner".into(), "-nostats".into(), "-y".into(),
        "-f".into(), "rawvideo".into(),
        "-pix_fmt".into(), "rgba".into(),
        "-s".into(), format!("{width}x{height}"),
        "-r".into(), format!("{fps}"),
        "-i".into(), "-".into(),
        "-i".into(), audio_path.to_string_lossy().into_owned(),
    ];
    for png in &card_pngs {
        encode_args.extend(["-i".into(), png.to_string_lossy().into_owned()]);
    }

    // Raw video is input 0, the audio 1, so the card PNGs start at 2.
    let (card_parts, last_label) =
        ffmpeg::card_graph_parts(cards, s, width, height, 2, "0:v", fps);
    let mut graph = card_parts;
    graph.push(format!("[{last_label}]format=yuv420p[vout]"));
    encode_args.extend(["-filter_complex".into(), graph.join(";")]);
    encode_args.extend(["-map".into(), "[vout]".into(), "-map".into(), "1:a".into()]);
    encode_args.extend(base.args[cut..base.args.len() - 1].iter().cloned().filter(|a| a != "-progress" && a != "pipe:1"));
    encode_args.push(tmp_output.to_string_lossy().into_owned());

    let mut temp_files = card_pngs;
    temp_files.push(audio_path);

    Ok(FilteredPlan {
        audio_args,
        decode_args,
        encode_args,
        width,
        height,
        fps,
        total_duration: base.total_duration,
        total_frames: (base.total_duration * fps).ceil() as u64,
        temp_files,
        clip_bounds: clip_frame_bounds(clips, fps),
    })
}



/// Runs decode -> GPU -> encode, reporting progress per frame.
/// `chains` holds one filter chain per clip; a clip with an empty chain has
/// its frames passed through untouched.
pub fn run(
    plan: &FilteredPlan,
    chains: &[Vec<FilterSpec>],
    handle: &ExportHandle,
    mut on_progress: impl FnMut(Progress),
) -> Result<(), FfError> {
    let ffmpeg_bin = ffmpeg::find_binary("ffmpeg")?;

    // Audio first, to completion.
    let audio = Command::new(&ffmpeg_bin).args(&plan.audio_args).output()?;
    if !audio.status.success() {
        let log = String::from_utf8_lossy(&audio.stderr);
        let tail: Vec<&str> = log.lines().rev().take(15).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(FfError::Failed {
            code: audio.status.code().unwrap_or(-1),
            log: format!("[audio]\n{}", tail.join("\n")),
        });
    }

    let mut decoder = Command::new(&ffmpeg_bin)
        .args(&plan.decode_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut encoder = Command::new(&ffmpeg_bin)
        .args(&plan.encode_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut dec_out = decoder.stdout.take().unwrap();
    let dec_err = decoder.stderr.take().unwrap();
    let mut enc_in = encoder.stdin.take().unwrap();
    let enc_err = encoder.stderr.take().unwrap();

    {
        let mut children = handle.0.lock().unwrap();
        children.push(decoder);
        children.push(encoder);
    }

    let dec_log = drain(dec_err);
    let enc_log = drain(enc_err);

    // Only spin the GPU up if something actually needs filtering.
    let any = chains.iter().any(|c| !c.is_empty());
    let mut gpu = if any {
        Some(FilterGpu::new().map_err(|e| FfError::Other(e.to_string()))?)
    } else {
        None
    };
    let frame_bytes = (plan.width as usize) * (plan.height as usize) * 4;
    let mut frame = vec![0u8; frame_bytes];
    let mut filtered = Vec::with_capacity(frame_bytes);
    let mut frames_done: u64 = 0;
    let started = std::time::Instant::now();

    let write_result = loop {
        match read_exact_or_eof(&mut dec_out, &mut frame)? {
            0 => break Ok(()),
            n if n < frame_bytes => break Ok(()), // trailing partial frame
            _ => {}
        }
        // Pick the chain belonging to the clip this frame came from.
        let clip_index = plan
            .clip_bounds
            .iter()
            .position(|&end| frames_done < end)
            .unwrap_or(plan.clip_bounds.len().saturating_sub(1));
        let chain = chains.get(clip_index).map(|c| c.as_slice()).unwrap_or(&[]);

        let to_write: &[u8] = if chain.is_empty() {
            &frame
        } else {
            let gpu = gpu.as_mut().expect("a chain implies the GPU was started");
            if let Err(e) = gpu.process(&frame, plan.width, plan.height, chain, &mut filtered) {
                break Err(FfError::Other(e.to_string()));
            }
            &filtered
        };
        if let Err(e) = enc_in.write_all(to_write) {
            // A dead encoder means its own log explains why.
            break Err(FfError::Io(e));
        }
        frames_done += 1;

        let secs = frames_done as f64 / plan.fps;
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        on_progress(Progress {
            percent: (frames_done as f64 / plan.total_frames.max(1) as f64 * 100.0).clamp(0.0, 99.9),
            out_time: secs,
            speed: format!("{:.2}x", secs / elapsed),
            fps: frames_done as f64 / elapsed,
            stage: "filtering".into(),
        });
    };
    drop(enc_in);

    let mut children = handle.take_all();
    let mut statuses = Vec::new();
    for mut child in children.drain(..) {
        statuses.push(child.wait()?);
    }
    write_result?;

    let dec_log = dec_log.join().unwrap_or_default();
    let enc_log = enc_log.join().unwrap_or_default();

    for (status, log, who) in [
        (statuses.first(), dec_log, "decode"),
        (statuses.get(1), enc_log, "encode"),
    ] {
        let Some(status) = status else { continue };
        if status.success() {
            continue;
        }
        if status.code().is_none() {
            return Err(FfError::Cancelled);
        }
        let tail: Vec<&str> = log.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(FfError::Failed {
            code: status.code().unwrap_or(-1),
            log: format!("[{who}]\n{}", tail.join("\n")),
        });
    }
    Ok(())
}

fn drain(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = pipe.read_to_string(&mut s);
        s
    })
}

/// Fills `buf`, returning how many bytes were read before end of stream.
fn read_exact_or_eof(r: &mut impl Read, buf: &mut [u8]) -> Result<usize, FfError> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FfError::Io(e)),
        }
    }
    Ok(filled)
}

/// Kept so the module owns its own temp cleanup.
pub fn cleanup(plan: &FilteredPlan) {
    for f in &plan.temp_files {
        let _ = std::fs::remove_file(f);
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::StereoMode;
    use std::collections::HashMap;

    fn gen(dir: &Path, secs: u32) -> String {
        let p = dir.join("a.mp4");
        let status = Command::new(ffmpeg::find_binary("ffmpeg").unwrap())
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size=640x320:rate=30:duration={secs}"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={secs}"))
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&p)
            .status()
            .unwrap();
        assert!(status.success());
        p.to_string_lossy().into_owned()
    }

    fn clip(path: String) -> ExportClip {
        ExportClip {
            path, in_point: 0.0, out_point: 2.0,
            yaw: 0.0, pitch: 0.0, roll: 0.0,
            has_audio: true, stereo_mode: StereoMode::Mono,
            width: 640, height: 320, fps: 30.0,
        }
    }

    fn settings(out: &Path) -> ExportSettings {
        ExportSettings {
            output: out.to_string_lossy().into_owned(),
            encoder: "libx264".into(), width: 640, height: 320, fps: 30.0,
            video_bitrate_mbps: 6.0, audio_bitrate_kbps: 128,
            stereo_mode: StereoMode::Mono, faststart: true, inject_spherical: false,
        }
    }

    /// How fast the filtered path runs at 4K. Ignored by default because it
    /// takes a while; run with `cargo test --release bench_4k -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_4k() {
        let dir = std::env::temp_dir().join(format!("editor360-bench-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let secs = 10u32;
        let src = dir.join("a.mp4");
        assert!(Command::new(ffmpeg::find_binary("ffmpeg").unwrap())
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size=3840x1920:rate=30:duration={secs}"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={secs}"))
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"])
            .arg(&src).status().unwrap().success());

        for filter in ["Grayscale", "Monet", "Painting"] {
            let out = dir.join("out.mp4");
            let tmp = dir.join("tmp.mp4");
            let mut clips = vec![clip(src.to_string_lossy().into_owned())];
            clips[0].out_point = secs as f64;
            clips[0].width = 3840;
            clips[0].height = 1920;
            let mut st = settings(&out);
            st.width = 3840;
            st.height = 1920;
            st.encoder = "hevc_videotoolbox".into();
            st.video_bitrate_mbps = 60.0;

            let filters = vec![vec![FilterSpec { name: filter.into(), params: HashMap::new() }]];
            let plan = build(&clips, &[], &st, &tmp).unwrap();
            let started = std::time::Instant::now();
            run(&plan, &filters, &ExportHandle::default(), |_| {}).unwrap();
            let elapsed = started.elapsed().as_secs_f64();
            println!("{filter:<10} 4K {secs}s -> {elapsed:6.2}s  = {:.2}x realtime", secs as f64 / elapsed);
            cleanup(&plan);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Two clips, only the second filtered: the frames must change partway
    /// through and not before.
    #[test]
    fn filters_apply_per_clip() {
        let dir = std::env::temp_dir().join(format!("editor360-perclip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen(&dir, 4);
        let out = dir.join("out.mp4");
        let tmp = dir.join("tmp.mp4");

        // Same source twice, so any difference comes from the filters alone.
        let mut a = clip(src.clone());
        a.in_point = 0.0;
        a.out_point = 2.0;
        let mut b = clip(src);
        b.in_point = 0.0;
        b.out_point = 2.0;
        let clips = vec![a, b];

        let chains = vec![
            vec![],
            vec![FilterSpec { name: "Grayscale".into(), params: HashMap::new() }],
        ];
        let plan = build(&clips, &[], &settings(&out), &tmp).unwrap();
        assert_eq!(plan.clip_bounds, vec![60, 120]);
        run(&plan, &chains, &ExportHandle::default(), |_| {}).unwrap();

        let colourfulness = |at: &str| -> usize {
            let bytes = Command::new(ffmpeg::find_binary("ffmpeg").unwrap())
                .args(["-v", "error", "-ss", at, "-i"])
                .arg(&tmp)
                .args(["-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
                .output().unwrap().stdout;
            bytes.chunks_exact(3)
                .filter(|p| (p[0] as i32 - p[1] as i32).abs() > 12 || (p[1] as i32 - p[2] as i32).abs() > 12)
                .count()
        };

        let first = colourfulness("1.0");
        let second = colourfulness("3.0");
        assert!(first > 1000, "first clip should keep its colour ({first})");
        assert!(second < first / 20, "second clip should be grey ({second} vs {first})");

        cleanup(&plan);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The whole path: ffmpeg decode, GPU filter, ffmpeg encode, with audio
    /// carried through and the result actually playable.
    #[test]
    fn filtered_export_produces_a_playable_greyscale_video() {
        let dir = std::env::temp_dir().join(format!("editor360-filt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen(&dir, 2);
        let out = dir.join("out.mp4");
        let tmp = dir.join("tmp.mp4");

        let clips = vec![clip(src)];
        let filters = vec![vec![FilterSpec { name: "Grayscale".into(), params: HashMap::new() }]];
        let plan = build(&clips, &[], &settings(&out), &tmp).unwrap();
        assert_eq!((plan.width, plan.height), (640, 320));
        assert_eq!(plan.total_frames, 60);

        let mut last = 0.0;
        run(&plan, &filters, &ExportHandle::default(), |p| last = p.percent).unwrap();
        assert!(last > 50.0, "no progress reported ({last})");

        let info = ffmpeg::probe(&tmp.to_string_lossy()).unwrap();
        assert!((info.duration - 2.0).abs() < 0.2, "duration {}", info.duration);
        assert!(info.has_audio, "audio was lost");
        assert_eq!((info.width, info.height), (640, 320));

        // Grayscale must actually have been applied: sample a frame and check
        // the channels match.
        let out_bytes = Command::new(ffmpeg::find_binary("ffmpeg").unwrap())
            .args(["-v", "error", "-ss", "1", "-i"])
            .arg(&tmp)
            .args(["-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"])
            .output()
            .unwrap()
            .stdout;
        let coloured = out_bytes
            .chunks_exact(3)
            .filter(|p| (p[0] as i32 - p[1] as i32).abs() > 12 || (p[1] as i32 - p[2] as i32).abs() > 12)
            .count();
        let total = out_bytes.len() / 3;
        assert!(coloured * 100 / total.max(1) < 2,
                "frame still has colour: {coloured} of {total} pixels");

        cleanup(&plan);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
