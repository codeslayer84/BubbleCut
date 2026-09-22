# 360 Editor

A desktop editor for 360° (equirectangular) video with one-click export that
plays correctly in VR headsets and on YouTube/Vimeo 360.

Built with **Tauri 2 (Rust) + React + Three.js**, and **ffmpeg** for every
decode/encode step.

## What it does (v0.1)

- Import equirectangular MP4/MOV — mono or stereo (top-bottom / side-by-side),
  detected from existing metadata or aspect ratio.
- 360° preview: drag to look around, scroll to zoom. Stereo sources preview
  the left/top eye.
- Timeline: trim (drag clip edges or `I`/`O`), split (`S`), reorder, remove.
- Per-clip **orientation** (yaw/pitch/roll) — set where the viewer starts
  looking. "Set current view as front" takes whatever is under the reticle.
  Preview matches ffmpeg's `v360` filter exactly.
- **Text cards**: place captions anywhere in the 360° sphere, with a time
  range, angular size, colours and a background box. Cards are rendered once
  on an HTML canvas and that same canvas is used for both the preview texture
  and the exported PNG, so what you see is exactly what gets burned in.
  In export they are projected with `v360=flat:e` so they read as flat signs
  in a headset instead of being smeared across the equirectangular frame.
- **Export**: single ffmpeg run (trim → `v360` → concat → encode), hardware
  HEVC/H.264 via VideoToolbox, presets for YouTube VR / Quest / Vision Pro,
  live progress + ETA, cancel.
- **Spherical metadata** written by our own MP4 box injector (`src-tauri/src/spherical.rs`):
  v2 `st3d` + `sv3d` boxes and the v1 RDF `uuid` box. After export the file is
  verified two ways (our parser + ffprobe) and the result is shown in the UI.
- **Tools → Tag existing MP4 as 360°**: inject metadata into any file without
  re-encoding (seconds, not hours).
- Save / open projects (`*.360edit.json`).

## Requirements

- macOS (Linux/Windows should work but are untested)
- `ffmpeg` + `ffprobe` on PATH, or in `/opt/homebrew/bin`, `/usr/local/bin`,
  or the directory named by `EDITOR360_FFMPEG_DIR`
- Node 22 (`.nvmrc`), Rust stable

## Run

```bash
npm install
npm run tauri dev
```

Browser-only UI dev (no export): `npm run dev` then open
<http://localhost:1420/?dev> — loads a labelled test clip from `public/dev/`.

Rust tests (need ffmpeg): `cd src-tauri && cargo test`.

## Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Step one frame (Shift: 1 s) |
| Home | Go to start |
| I / O | Set in / out point at playhead |
| S | Split at playhead |
| Delete | Remove selected clip |

## How export works

1. `ffmpeg` with one `-filter_complex`: each clip `trim` → optional
   `v360=e:e:yaw:pitch:roll` (+ stereo layout conversion) → `scale`/`fps` →
   `concat`. Clips without audio get silence so concat stays aligned.
2. Encode to a temp file next to the output (`hvc1` tag for HEVC, 2 s GOP,
   AAC audio, optional faststart).
3. Text cards are projected onto the sphere and overlaid. `v360` drops the
   input alpha channel, so the card's alpha plane is extracted and projected
   separately with identical parameters, then recombined with `alphamerge`.
   `v360`'s rotations are the opposite sign to the editor's, so the angles are
   negated. For stereo output the projected card is stacked for both eyes.
4. `spherical::inject` rewrites the `moov` atom with the 360 boxes and fixes
   chunk offsets, streaming the rest of the file through unchanged.
5. `spherical::check` + `ffprobe` confirm the result; the ffmpeg command is
   shown in the UI so you can reproduce it by hand.

## Known limitations / next steps

- Preview decodes the source file in the webview; 8K HEVC may stutter.
  Planned: generate 2K proxies with ffmpeg for editing.
- Cuts only; no transitions yet.
- Text cards are static: no fades or animation, and no keyframed movement.
- Spatial (ambisonic) audio passes through as plain multichannel AAC — no
  `SA3D` box yet.
- Reframe-to-flat (keyframed camera → 16:9) is not implemented.
