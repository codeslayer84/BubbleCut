//! Spherical (360°) metadata injection for MP4/MOV files.
//!
//! Implements Google's Spherical Video spec:
//!  * v2 – `st3d` + `sv3d` boxes inside the video sample entry (`avc1`, `hvc1`…)
//!  * v1 – an RDF/XML `uuid` box inside the video `trak` (older players)
//!
//! Both are written for maximum compatibility. Growing `moov` shifts every
//! byte after it, so chunk offsets (`stco`/`co64`) pointing past `moov` are
//! corrected; `stco` tables that would overflow are promoted to `co64`.

use serde::Serialize;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::ffmpeg::StereoMode;

const SPHERICAL_UUID: [u8; 16] = [
    0xff, 0xcc, 0x82, 0x63, 0xf8, 0x55, 0x4a, 0x93, 0x88, 0x14, 0x58, 0x7a, 0x02, 0x52, 0x1f, 0xdd,
];

const VIDEO_SAMPLE_ENTRIES: &[&[u8; 4]] = &[
    b"avc1", b"avc3", b"hvc1", b"hev1", b"av01", b"vp08", b"vp09", b"mp4v", b"dvh1", b"dvhe",
    b"apch", b"apcn", b"apcs", b"apco", b"ap4h",
];

#[derive(Debug, thiserror::Error)]
pub enum SphError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("not an MP4/MOV file: {0}")]
    Format(String),
}

enum Payload {
    Raw(Vec<u8>),
    Container { prefix: Vec<u8>, children: Vec<MpBox> },
}

struct MpBox {
    typ: [u8; 4],
    payload: Payload,
}

impl MpBox {
    fn raw(typ: &[u8; 4], data: Vec<u8>) -> Self {
        MpBox { typ: *typ, payload: Payload::Raw(data) }
    }
    fn container(typ: &[u8; 4], prefix: Vec<u8>, children: Vec<MpBox>) -> Self {
        MpBox { typ: *typ, payload: Payload::Container { prefix, children } }
    }
    fn size(&self) -> u64 {
        8 + match &self.payload {
            Payload::Raw(d) => d.len() as u64,
            Payload::Container { prefix, children } => {
                prefix.len() as u64 + children.iter().map(|c| c.size()).sum::<u64>()
            }
        }
    }
    fn write(&self, out: &mut Vec<u8>) {
        let size = self.size();
        assert!(size <= u32::MAX as u64, "box too large for 32-bit size");
        out.extend_from_slice(&(size as u32).to_be_bytes());
        out.extend_from_slice(&self.typ);
        match &self.payload {
            Payload::Raw(d) => out.extend_from_slice(d),
            Payload::Container { prefix, children } => {
                out.extend_from_slice(prefix);
                for c in children {
                    c.write(out);
                }
            }
        }
    }
    fn children_mut(&mut self) -> Option<&mut Vec<MpBox>> {
        match &mut self.payload {
            Payload::Container { children, .. } => Some(children),
            _ => None,
        }
    }
    fn children(&self) -> Option<&Vec<MpBox>> {
        match &self.payload {
            Payload::Container { children, .. } => Some(children),
            _ => None,
        }
    }
    fn child(&self, typ: &[u8; 4]) -> Option<&MpBox> {
        self.children()?.iter().find(|c| &c.typ == typ)
    }
    fn child_mut(&mut self, typ: &[u8; 4]) -> Option<&mut MpBox> {
        self.children_mut()?.iter_mut().find(|c| &c.typ == typ)
    }
}

/// How many bytes of fixed fields precede child boxes, or `None` if the box
/// should be treated as opaque.
fn container_prefix_len(typ: &[u8; 4], parent: Option<&[u8; 4]>) -> Option<usize> {
    match typ {
        b"moov" | b"trak" | b"mdia" | b"minf" | b"stbl" | b"sv3d" | b"proj" => Some(0),
        b"stsd" => Some(8), // version/flags + entry_count
        _ if parent == Some(b"stsd") && VIDEO_SAMPLE_ENTRIES.contains(&typ) => Some(78),
        _ => None,
    }
}

fn parse_boxes(data: &[u8], parent: Option<&[u8; 4]>) -> Result<Vec<MpBox>, SphError> {
    let mut boxes = Vec::new();
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as u64;
        let typ: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap();
        let (size, hdr) = match size32 {
            0 => ((data.len() - pos) as u64, 8usize),
            1 => {
                if pos + 16 > data.len() {
                    return Err(SphError::Format("truncated box".into()));
                }
                (u64::from_be_bytes(data[pos + 8..pos + 16].try_into().unwrap()), 16usize)
            }
            s => (s, 8usize),
        };
        let end = pos + size as usize;
        if size < hdr as u64 || end > data.len() {
            return Err(SphError::Format(format!(
                "bad box size {} for {}",
                size,
                String::from_utf8_lossy(&typ)
            )));
        }
        let body = &data[pos + hdr..end];
        let b = match container_prefix_len(&typ, parent) {
            Some(plen) if body.len() >= plen => {
                let prefix = body[..plen].to_vec();
                let children = parse_boxes(&body[plen..], Some(&typ))?;
                MpBox::container(&typ, prefix, children)
            }
            _ => MpBox::raw(&typ, body.to_vec()),
        };
        boxes.push(b);
        pos = end;
    }
    Ok(boxes)
}

fn full_box(typ: &[u8; 4], body: &[u8]) -> MpBox {
    let mut d = vec![0u8, 0, 0, 0]; // version + flags
    d.extend_from_slice(body);
    MpBox::raw(typ, d)
}

fn build_st3d(stereo: &StereoMode) -> MpBox {
    let mode: u8 = match stereo {
        StereoMode::Mono => 0,
        StereoMode::TopBottom => 1,
        StereoMode::LeftRight => 2,
    };
    full_box(b"st3d", &[mode])
}

fn build_sv3d() -> MpBox {
    let mut svhd = b"360 Editor".to_vec();
    svhd.push(0);
    let prhd = full_box(b"prhd", &[0u8; 12]); // pose yaw/pitch/roll = 0 (16.16 fixed)
    let equi = full_box(b"equi", &[0u8; 16]); // full-frame equirect bounds
    let proj = MpBox::container(b"proj", vec![], vec![prhd, equi]);
    MpBox::container(b"sv3d", vec![], vec![full_box(b"svhd", &svhd), proj])
}

fn build_v1_uuid(stereo: &StereoMode) -> MpBox {
    let stereo_xml = match stereo {
        StereoMode::Mono => String::new(),
        StereoMode::TopBottom => "<GSpherical:StereoMode>top-bottom</GSpherical:StereoMode>".into(),
        StereoMode::LeftRight => "<GSpherical:StereoMode>left-right</GSpherical:StereoMode>".into(),
    };
    let xml = format!(
        "<?xml version=\"1.0\"?><rdf:SphericalVideo xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" \
xmlns:GSpherical=\"http://ns.google.com/videos/1.0/spherical/\">\
<GSpherical:Spherical>true</GSpherical:Spherical>\
<GSpherical:Stitched>true</GSpherical:Stitched>\
<GSpherical:StitchingSoftware>360 Editor</GSpherical:StitchingSoftware>\
<GSpherical:ProjectionType>equirectangular</GSpherical:ProjectionType>\
{stereo_xml}</rdf:SphericalVideo>"
    );
    let mut d = SPHERICAL_UUID.to_vec();
    d.extend_from_slice(xml.as_bytes());
    MpBox::raw(b"uuid", d)
}

fn is_video_trak(trak: &MpBox) -> bool {
    trak.child(b"mdia")
        .and_then(|m| m.child(b"hdlr"))
        .map(|h| match &h.payload {
            // hdlr: version/flags(4) pre_defined(4) handler_type(4)
            Payload::Raw(d) => d.len() >= 12 && &d[8..12] == b"vide",
            _ => false,
        })
        .unwrap_or(false)
}

fn is_spherical_uuid(b: &MpBox) -> bool {
    matches!(&b.payload, Payload::Raw(d) if d.len() >= 16 && d[..16] == SPHERICAL_UUID)
}

/// Add/replace spherical boxes in every video track. Returns number of tracks tagged.
fn tag_moov(moov: &mut MpBox, stereo: &StereoMode) -> usize {
    let mut tagged = 0;
    let Some(children) = moov.children_mut() else { return 0 };
    for trak in children.iter_mut().filter(|t| &t.typ == b"trak") {
        if !is_video_trak(trak) {
            continue;
        }
        // v2 boxes inside each video sample entry.
        if let Some(stsd) = trak
            .child_mut(b"mdia")
            .and_then(|m| m.child_mut(b"minf"))
            .and_then(|m| m.child_mut(b"stbl"))
            .and_then(|s| s.child_mut(b"stsd"))
        {
            if let Some(entries) = stsd.children_mut() {
                for entry in entries.iter_mut() {
                    if let Some(kids) = entry.children_mut() {
                        kids.retain(|k| &k.typ != b"st3d" && &k.typ != b"sv3d");
                        kids.push(build_st3d(stereo));
                        kids.push(build_sv3d());
                        tagged += 1;
                    }
                }
            }
        }
        // v1 uuid directly inside trak.
        if let Some(kids) = trak.children_mut() {
            kids.retain(|k| !(&k.typ == b"uuid" && is_spherical_uuid(k)));
            kids.push(build_v1_uuid(stereo));
        }
    }
    tagged
}

/// Shift chunk offsets that point past `moov_start` by `delta`, promoting
/// `stco` to `co64` where needed. Returns true if any table was promoted
/// (which changes moov's size, so the caller must recompute delta).
fn shift_chunk_offsets(b: &mut MpBox, moov_start: u64, delta: i64) -> bool {
    let mut promoted = false;
    if let Some(kids) = b.children_mut() {
        for k in kids.iter_mut() {
            match &k.typ {
                b"stco" => {
                    if let Payload::Raw(d) = &mut k.payload {
                        let n = u32::from_be_bytes(d[4..8].try_into().unwrap()) as usize;
                        let mut new: Vec<u64> = Vec::with_capacity(n);
                        let mut overflow = false;
                        for i in 0..n {
                            let off = u32::from_be_bytes(d[8 + i * 4..12 + i * 4].try_into().unwrap()) as u64;
                            let v = if off > moov_start { (off as i64 + delta) as u64 } else { off };
                            if v > u32::MAX as u64 {
                                overflow = true;
                            }
                            new.push(v);
                        }
                        let mut out = d[..8].to_vec();
                        if overflow {
                            for v in new {
                                out.extend_from_slice(&v.to_be_bytes());
                            }
                            k.typ = *b"co64";
                            promoted = true;
                        } else {
                            for v in new {
                                out.extend_from_slice(&(v as u32).to_be_bytes());
                            }
                        }
                        *d = out;
                    }
                }
                b"co64" => {
                    if let Payload::Raw(d) = &mut k.payload {
                        let n = u32::from_be_bytes(d[4..8].try_into().unwrap()) as usize;
                        for i in 0..n {
                            let r = 8 + i * 8..16 + i * 8;
                            let off = u64::from_be_bytes(d[r.clone()].try_into().unwrap());
                            if off > moov_start {
                                d[r].copy_from_slice(&((off as i64 + delta) as u64).to_be_bytes());
                            }
                        }
                    }
                }
                _ => {
                    promoted |= shift_chunk_offsets(k, moov_start, delta);
                }
            }
        }
    }
    promoted
}

struct TopLevel {
    typ: [u8; 4],
    offset: u64,
    size: u64,
    header: u64,
}

fn scan_top_level(f: &mut File) -> Result<Vec<TopLevel>, SphError> {
    let len = f.metadata()?.len();
    let mut pos = 0u64;
    let mut out = Vec::new();
    let mut hdr = [0u8; 16];
    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos))?;
        f.read_exact(&mut hdr[..8])?;
        let size32 = u32::from_be_bytes(hdr[..4].try_into().unwrap()) as u64;
        let typ: [u8; 4] = hdr[4..8].try_into().unwrap();
        let (size, header) = match size32 {
            0 => (len - pos, 8),
            1 => {
                f.read_exact(&mut hdr[8..16])?;
                (u64::from_be_bytes(hdr[8..16].try_into().unwrap()), 16)
            }
            s => (s, 8),
        };
        if size < header || pos + size > len {
            return Err(SphError::Format("corrupt top-level box".into()));
        }
        out.push(TopLevel { typ, offset: pos, size, header });
        pos += size;
    }
    if out.is_empty() || &out[0].typ != b"ftyp" {
        return Err(SphError::Format("missing ftyp".into()));
    }
    Ok(out)
}

fn copy_range(src: &mut File, dst: &mut impl Write, start: u64, len: u64) -> io::Result<()> {
    src.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::with_capacity(1 << 20, src.take(len));
    io::copy(&mut reader, dst)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectReport {
    pub tracks_tagged: usize,
    pub moov_delta_bytes: i64,
    pub promoted_co64: bool,
}

/// Write `output` = `input` with spherical metadata. `input` and `output` may
/// not be the same path.
pub fn inject(input: &Path, output: &Path, stereo: &StereoMode) -> Result<InjectReport, SphError> {
    let mut f = File::open(input)?;
    let tops = scan_top_level(&mut f)?;
    let moov_tl = tops
        .iter()
        .find(|t| &t.typ == b"moov")
        .ok_or_else(|| SphError::Format("no moov box (fragmented or incomplete file?)".into()))?;

    // Parse moov.
    f.seek(SeekFrom::Start(moov_tl.offset + moov_tl.header))?;
    let mut moov_bytes = vec![0u8; (moov_tl.size - moov_tl.header) as usize];
    f.read_exact(&mut moov_bytes)?;
    let mut moov = MpBox::container(b"moov", vec![], parse_boxes(&moov_bytes, Some(b"moov"))?);

    // Sanity: the parser must round-trip an untouched moov byte-for-byte.
    {
        let mut check = Vec::with_capacity(moov_bytes.len() + 8);
        moov.write(&mut check);
        if check.len() as u64 != moov_tl.size || check[8..] != moov_bytes[..] {
            return Err(SphError::Format(
                "moov did not round-trip through the parser; refusing to modify".into(),
            ));
        }
    }

    let tracks_tagged = tag_moov(&mut moov, stereo);
    if tracks_tagged == 0 {
        return Err(SphError::Format("no video track with a recognised sample entry".into()));
    }

    // Fix chunk offsets; loop because stco→co64 promotion grows moov again.
    let mut promoted_any = false;
    let mut applied: i64 = 0;
    loop {
        let delta = moov.size() as i64 - moov_tl.size as i64;
        let step = delta - applied;
        let promoted = shift_chunk_offsets(&mut moov, moov_tl.offset, step);
        applied = delta;
        promoted_any |= promoted;
        if !promoted {
            break;
        }
    }
    let delta = moov.size() as i64 - moov_tl.size as i64;

    // Write output: [0, moov) + new moov + (moov_end, EOF).
    let mut new_moov = Vec::with_capacity(moov.size() as usize);
    moov.write(&mut new_moov);
    let total_len = f.metadata()?.len();
    let mut out = BufWriter::with_capacity(1 << 20, File::create(output)?);
    copy_range(&mut f, &mut out, 0, moov_tl.offset)?;
    out.write_all(&new_moov)?;
    let after = moov_tl.offset + moov_tl.size;
    copy_range(&mut f, &mut out, after, total_len - after)?;
    out.flush()?;

    Ok(InjectReport { tracks_tagged, moov_delta_bytes: delta, promoted_co64: promoted_any })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SphericalCheck {
    pub has_sv3d: bool,
    pub has_st3d: bool,
    pub has_v1_uuid: bool,
    pub stereo_mode: Option<String>,
}

/// Independent read-back of the boxes we care about.
pub fn check(path: &Path) -> Result<SphericalCheck, SphError> {
    let mut f = File::open(path)?;
    let tops = scan_top_level(&mut f)?;
    let moov_tl = tops
        .iter()
        .find(|t| &t.typ == b"moov")
        .ok_or_else(|| SphError::Format("no moov".into()))?;
    f.seek(SeekFrom::Start(moov_tl.offset + moov_tl.header))?;
    let mut bytes = vec![0u8; (moov_tl.size - moov_tl.header) as usize];
    f.read_exact(&mut bytes)?;
    let moov = MpBox::container(b"moov", vec![], parse_boxes(&bytes, Some(b"moov"))?);

    let mut r = SphericalCheck::default();
    for trak in moov.children().unwrap().iter().filter(|t| &t.typ == b"trak") {
        if !is_video_trak(trak) {
            continue;
        }
        r.has_v1_uuid |= trak.children().unwrap().iter().any(is_spherical_uuid);
        if let Some(stsd) = trak
            .child(b"mdia")
            .and_then(|m| m.child(b"minf"))
            .and_then(|m| m.child(b"stbl"))
            .and_then(|s| s.child(b"stsd"))
        {
            for entry in stsd.children().unwrap() {
                if let Some(kids) = entry.children() {
                    r.has_sv3d |= kids.iter().any(|k| &k.typ == b"sv3d");
                    if let Some(st3d) = kids.iter().find(|k| &k.typ == b"st3d") {
                        r.has_st3d = true;
                        if let Payload::Raw(d) = &st3d.payload {
                            r.stereo_mode = Some(
                                match d.get(4) {
                                    Some(1) => "top-bottom",
                                    Some(2) => "left-right",
                                    _ => "mono",
                                }
                                .into(),
                            );
                        }
                    }
                }
            }
        }
    }
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn ffmpeg() -> std::path::PathBuf {
        crate::ffmpeg::find_binary("ffmpeg").expect("ffmpeg on PATH for tests")
    }

    fn make_clip(dir: &Path, name: &str, faststart: bool) -> std::path::PathBuf {
        let p = dir.join(name);
        let mut args = vec![
            "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x320:rate=30:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        ];
        if faststart {
            args.extend(["-movflags", "+faststart"]);
        }
        let status = Command::new(ffmpeg()).args(&args).arg(&p).status().unwrap();
        assert!(status.success());
        p
    }

    fn decodes_cleanly(p: &Path) -> bool {
        let out = Command::new(ffmpeg())
            .args(["-v", "error", "-xerror", "-i"])
            .arg(p)
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        out.status.success() && out.stderr.is_empty()
    }

    fn run_case(faststart: bool, stereo: StereoMode) {
        let dir = std::env::temp_dir().join(format!("editor360-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = make_clip(&dir, "src.mp4", faststart);
        let dst = dir.join("tagged.mp4");
        let rep = inject(&src, &dst, &stereo).unwrap();
        assert_eq!(rep.tracks_tagged, 1);
        assert!(rep.moov_delta_bytes > 0);

        let chk = check(&dst).unwrap();
        assert!(chk.has_sv3d && chk.has_st3d && chk.has_v1_uuid, "{chk:?}");

        // Second opinion from ffprobe and a full decode (catches bad offsets).
        let probe = crate::ffmpeg::probe(&dst.to_string_lossy()).unwrap();
        assert!(probe.tagged_spherical, "ffprobe did not see spherical mapping");
        assert_eq!(probe.stereo_mode, stereo);
        assert!(!probe.stereo_guessed);
        assert!(decodes_cleanly(&dst), "tagged file does not decode cleanly");

        // Re-tagging must replace, not duplicate.
        let dst2 = dir.join("tagged2.mp4");
        let rep2 = inject(&dst, &dst2, &stereo).unwrap();
        assert_eq!(rep2.moov_delta_bytes, 0, "re-tag changed size: boxes duplicated?");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn moov_last_mono() {
        run_case(false, StereoMode::Mono);
    }
    #[test]
    fn moov_first_top_bottom() {
        run_case(true, StereoMode::TopBottom);
    }
    #[test]
    fn moov_first_left_right() {
        run_case(true, StereoMode::LeftRight);
    }
}
