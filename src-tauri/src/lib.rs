mod ffmpeg;
mod spherical;

use ffmpeg::{ExportClip, ExportHandle, ExportSettings, MediaInfo, StereoMode};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegInfo {
    version: String,
    encoders: Vec<String>,
}

#[tauri::command]
fn ffmpeg_info() -> Result<FfmpegInfo, String> {
    Ok(FfmpegInfo {
        version: ffmpeg::version().map_err(|e| e.to_string())?,
        encoders: ffmpeg::available_encoders().map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
fn probe_media(path: String) -> Result<MediaInfo, String> {
    ffmpeg::probe(&path).map_err(|e| e.to_string())
}

/// What ffprobe reports about the finished file — independent of our own
/// parser, so the user gets a second opinion that the file is really 360.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct ProbeVerification {
    spherical_mapping: bool,
    projection: Option<String>,
    stereo_3d: Option<String>,
}

fn verify_with_ffprobe(path: &Path) -> ProbeVerification {
    let mut v = ProbeVerification::default();
    let Ok(raw) = ffmpeg::probe_json(&path.to_string_lossy()) else { return v };
    let Some(streams) = raw.get("streams").and_then(|s| s.as_array()) else { return v };
    for s in streams {
        if s.get("codec_type").and_then(|c| c.as_str()) != Some("video") {
            continue;
        }
        if let Some(list) = s.get("side_data_list").and_then(|l| l.as_array()) {
            for sd in list {
                match sd.get("side_data_type").and_then(|t| t.as_str()) {
                    Some("Spherical Mapping") => {
                        v.spherical_mapping = true;
                        v.projection = sd.get("projection").and_then(|p| p.as_str()).map(String::from);
                    }
                    Some("Stereo 3D") => {
                        v.stereo_3d = sd.get("type").and_then(|p| p.as_str()).map(String::from);
                    }
                    _ => {}
                }
            }
        }
    }
    v
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportDone {
    output: String,
    file_size: u64,
    inject: Option<spherical::InjectReport>,
    boxes: Option<spherical::SphericalCheck>,
    ffprobe: ProbeVerification,
    command: String,
}

fn shell_quote(a: &str) -> String {
    if a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=+,".contains(c)) {
        a.to_string()
    } else {
        format!("'{}'", a.replace('\'', "'\\''"))
    }
}

#[tauri::command]
fn start_export(
    app: AppHandle,
    handle: State<'_, ExportHandle>,
    clips: Vec<ExportClip>,
    settings: ExportSettings,
) -> Result<(), String> {
    if handle.0.lock().unwrap().is_some() {
        return Err("an export is already running".into());
    }
    let output = PathBuf::from(&settings.output);
    let tmp = output.with_file_name(format!(
        ".{}.{}.tmp.mp4",
        output.file_stem().map(|s| s.to_string_lossy()).unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    let plan = ffmpeg::build_plan(&clips, &settings, &tmp).map_err(|e| e.to_string())?;
    let handle = handle.inner().clone();
    let command = std::iter::once("ffmpeg".to_string())
        .chain(plan.args.iter().map(|a| shell_quote(a)))
        .collect::<Vec<_>>()
        .join(" ");

    std::thread::spawn(move || {
        let result = (|| -> Result<ExportDone, String> {
            let app2 = app.clone();
            ffmpeg::run(&plan, &handle, move |p| {
                let _ = app2.emit("export:progress", p);
            })
            .map_err(|e| e.to_string())?;

            let (inject, boxes) = if settings.inject_spherical {
                let _ = app.emit(
                    "export:progress",
                    ffmpeg::Progress {
                        percent: 99.9,
                        out_time: plan.total_duration,
                        speed: String::new(),
                        fps: 0.0,
                        stage: "writing 360 metadata".into(),
                    },
                );
                let rep = spherical::inject(&tmp, &output, &settings.stereo_mode)
                    .map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&tmp);
                let chk = spherical::check(&output).map_err(|e| e.to_string())?;
                (Some(rep), Some(chk))
            } else {
                std::fs::rename(&tmp, &output).map_err(|e| e.to_string())?;
                (None, None)
            };
            let file_size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
            Ok(ExportDone {
                output: output.to_string_lossy().into_owned(),
                file_size,
                inject,
                boxes,
                ffprobe: verify_with_ffprobe(&output),
                command: command.clone(),
            })
        })();
        let _ = std::fs::remove_file(&tmp);
        match result {
            Ok(done) => {
                let _ = app.emit("export:done", done);
            }
            Err(msg) => {
                let _ = app.emit("export:error", msg);
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_export(handle: State<'_, ExportHandle>) -> bool {
    handle.cancel()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagResult {
    inject: spherical::InjectReport,
    boxes: spherical::SphericalCheck,
    ffprobe: ProbeVerification,
}

/// Standalone tool: add 360 metadata to an existing MP4 without re-encoding.
#[tauri::command]
fn tag_spherical(input: String, output: String, stereo: StereoMode) -> Result<TagResult, String> {
    let (i, o) = (Path::new(&input), Path::new(&output));
    if i == o {
        return Err("choose a different output path".into());
    }
    let inject = spherical::inject(i, o, &stereo).map_err(|e| e.to_string())?;
    let boxes = spherical::check(o).map_err(|e| e.to_string())?;
    Ok(TagResult { inject, boxes, ffprobe: verify_with_ffprobe(o) })
}

#[tauri::command]
fn check_spherical(path: String) -> Result<spherical::SphericalCheck, String> {
    spherical::check(Path::new(&path)).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ExportHandle::default())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_info,
            probe_media,
            start_export,
            cancel_export,
            tag_spherical,
            check_spherical
        ])
        .setup(|app| {
            // Surface the ffmpeg location in the log for troubleshooting.
            match ffmpeg::version() {
                Ok(v) => eprintln!("[360editor] {v}"),
                Err(e) => eprintln!("[360editor] {e}"),
            }
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
