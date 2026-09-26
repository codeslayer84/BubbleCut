# Bubblecut

A desktop editor for 360° (equirectangular) video, built for research
recordings rather than for broadcast, with one-click export that plays
correctly in VR headsets and on YouTube/Vimeo 360.

© 2026 Jacob Davidsen · Big Soft Video · Aalborg University. All rights
reserved. Image filters are based on 360mash (Big Soft Video, Aalborg
University); decoding and encoding are done by FFmpeg.

Built with **Tauri 2 (Rust) + React + Three.js**, and **ffmpeg** for every
decode/encode step.

## What it does (v0.1)

- Import equirectangular MP4/MOV — mono or stereo (top-bottom / side-by-side),
  detected from existing metadata or aspect ratio.
- 360° preview: drag to look around, scroll to zoom. Stereo sources preview
  the left/top eye.
- Timeline: trim (drag clip edges or `I`/`O`), split (`S`), reorder, remove.
  Drag along the ruler to mark a range, or Cmd-click and Shift-click clips to
  pick several; the Export panel can then export the whole timeline, just that
  range, those clips joined, or each clip as its own numbered file.
  Text cards appear on their own lane beneath the clips, where they can be
  dragged along the timeline or have either end pulled. Overlapping cards
  stack onto separate rows, and the darkened wedges show their fades.
- Per-clip **orientation** (yaw/pitch/roll) — set where the viewer starts
  looking. "Set current view as front" takes whatever is under the reticle.
  Preview matches ffmpeg's `v360` filter exactly.
- **Title cards**: "+ Title" drops a block of flat colour in at the playhead,
  splitting whatever is there. The words are an ordinary text card laid over
  it, so the font, colour, fades and timing all work as they do elsewhere, and
  the colour and length are on the Clip tab.
- **Text cards**: place captions anywhere in the 360° sphere, with a time
  range, angular size, colours and a background box. Cards are rendered once
  on an HTML canvas and that same canvas is used for both the preview texture
  and the exported PNG, so what you see is exactly what gets burned in.
  In export they are projected with `v360=flat:e` so they read as flat signs
  in a headset instead of being smeared across the equirectangular frame.
  Each card can fade in and out. New cards span the whole video by default.
  While a card is selected and playback is paused it is drawn at full opacity
  so it can be positioned even when the playhead sits inside one of its fades;
  playback shows the real opacity, and the panel reports it.
- **Filters (per clip)**: shown as badges on the clip in the timeline, which
  open that clip's filters when clicked. The image filters from
  [360mash](https://www.bigvideo.aau.dk/) — Grayscale, Pixelate, News Print,
  Charcoal, Cartoon, Monet and Painting — running the same shader maths, plus
  a **Van Gogh**, a **Watercolour** and a **Pencil Drawing** filter of our
  own, with
  a live preview. Each clip carries its own chain, with "Apply to all clips"
  when you want the lot. 360mash encodes with libav compiled to WebAssembly; here the
  shaders run on the GPU through wgpu while ffmpeg keeps the decoding and the
  hardware encoding. Measured on an M4 Max at 4K: 1.33x realtime for
  Grayscale, 1.05x for Monet, 0.95x for Painting.
- **Export**: single ffmpeg run (trim → `v360` → concat → encode), hardware
  HEVC/H.264 via VideoToolbox, presets for YouTube VR / Quest / Vision Pro,
  live progress + ETA, cancel.
- **Spherical metadata** written by our own MP4 box injector (`src-tauri/src/spherical.rs`):
  v2 `st3d` + `sv3d` boxes and the v1 RDF `uuid` box. After export the file is
  verified two ways (our parser + ffprobe) and the result is shown in the UI.
- **Tools → Tag existing MP4 as 360°**: inject metadata into any file without
  re-encoding (seconds, not hours).
- **CAVA360VR export**: untick "Burn text cards into the video" and save the
  cards as a `.cards.json` sidecar instead. In CAVA the cards become objects in
  the sphere that can be pointed at and moved, rather than pixels. See
  `Assets/Scripts/Cards/README.md` in the CAVA project.
- Save / open projects (`*.360edit.json`).


## Requirements

- macOS (Linux/Windows should work but are untested)
- A **native** `ffmpeg` + `ffprobe` (`brew install ffmpeg`). Not bundled, on
  purpose — see [THIRD-PARTY.md](THIRD-PARTY.md). The app checks at startup and
  shows the install command for your platform if it cannot find them. On Apple Silicon an
  Intel-only build runs under Rosetta, loses the hardware video encoder and is
  about 20x slower; the app prefers a native binary and warns if only an
  emulated one is found.
- `ffmpeg` + `ffprobe` on PATH, or in `/opt/homebrew/bin`, `/usr/local/bin`,
  or the directory named by `BUBBLECUT_FFMPEG_DIR`
- Node 22 (`.nvmrc`), Rust stable


## Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| ← / → | Step one frame (Shift: 1 s) |
| Home | Go to start |
| I / O | Set in / out point at playhead |
| S | Split at playhead |
| Delete | Remove selected clip |
| Cmd-click | Add or remove a clip from the selection, edges included |
| Shift-click | Select a run of clips |

## How export works

1. `ffmpeg` with one `-filter_complex`: each clip `trim` → optional
   `v360=e:e:yaw:pitch:roll` (+ stereo layout conversion) → `scale`/`fps` →
   `concat`. Clips without audio get silence so concat stays aligned.
2. Encode to a temp file next to the output (`hvc1` tag for HEVC, 2 s GOP,
   AAC audio, optional faststart).
3. Text cards are projected onto the sphere and overlaid. A still image is a
   single frame, which temporal filters cannot animate, so a fading card is
   projected once and then replicated with `loop` before `fade` is applied —
   re-projecting every frame would be far more expensive at 8K. `v360` drops the
   input alpha channel, so the card's alpha plane is extracted and projected
   separately with identical parameters, then recombined with `alphamerge`.
   `v360`'s rotations are the opposite sign to the editor's, so the angles are
   negated. For stereo output the projected card is stacked for both eyes.
4. `spherical::inject` rewrites the `moov` atom with the 360 boxes and fixes
   chunk offsets, streaming the rest of the file through unchanged.
5. `spherical::check` + `ffprobe` confirm the result; the ffmpeg command is
   shown in the UI so you can reproduce it by hand.

## Exporting part of the timeline

A range is applied by slicing the clips themselves rather than exporting
everything and trimming the result: ffmpeg then seeks straight to each piece
instead of decoding footage that is about to be discarded, and the rest of the
pipeline carries on unchanged because it only sees a shorter clip list. Cards
are shifted to the new zero and dropped if they fall outside.

Exporting each clip to its own file runs the exports one after another; the
backend refuses a second export while one is in flight.

## How filters are applied

This ffmpeg has no libplacebo, OpenCL or Vulkan, so GLSL cannot run inside its
filter graph. With filters active the export splits in three:

1. An audio-only pass writes the joined audio to a temporary WAV. It has to
   finish first: if it shared a process with the video, the encoder would wait
   on a half-written file while the decoder waited for its video pipe to
   drain, and the two would deadlock.
2. ffmpeg trims, reorients and joins the clips, emitting raw RGBA frames on
   stdout. RGBA rather than yuv420p so the filters see full chroma.
3. Each frame goes through the GPU, then into a second ffmpeg that draws the
   text cards on top — so captions are never filtered — and encodes with
   VideoToolbox. Frames arrive as one concatenated stream, so a frame's clip
   is worked out from its index and that clip's chain is used; a clip with no
   filters skips the GPU entirely.

The shaders are ported to WGSL in `src-tauri/src/shaders/`; the preview uses
360mash's original GLSL unchanged, since the preview is WebGL too.

## The Van Gogh filter

Not a 360mash port. Brush strokes follow the picture's *contours* rather than
its gradients, which is what gives Starry Night its swirls, so the stroke
direction is the tangent of the luminance gradient. Noise smeared along that
direction (a line integral convolution) makes the bristle marks, and sampling
the same smeared noise again slightly across the stroke gives a slope that
lights the ridges like thick paint.

Averaging raw gradients to steady the flow would cancel them out, since a
direction and its opposite describe the same stroke. The structure tensor is
averaged instead and its minor eigenvector taken; without that the strokes
scatter wherever the detail is fine.

## The Watercolour filter

Four things make watercolour read as watercolour, and the filter does all of
them: the paint pools into flat washes rather than shading smoothly (a
Kuwahara filter, which keeps the boundaries crisp); water carries pigment past
the drawing, so sampling is displaced by a slow noise and the washes wander off
the picture's own edges; pigment collects as a wash dries at its rim, which is
the dark line around every shape; and it settles into the tooth of the paper,
which is the grain. A slow blotching keeps any wash from being perfectly even.

Colour is not merely turned up. Raising the saturation cannot put colour into
an area that has none, so the hue wanders slowly across the paper the way one
pigment does, and the shadows and lights are pulled apart towards cool and
warm — both of which give a nearly grey scene real colour. The vibrance on top
pushes the dull parts hardest and leaves the vivid ones alone, so strong colour
does not simply clip.

## Presets

A clip's filters, with their settings, can be saved under a name and applied
to any clip in any project. They live outside the project file, in the app's
config folder, so a look built for one recording carries over to the next and
the file can be handed to someone else.

## The Pencil Drawing filter

Tone comes from the dodge trick: divide the grey by one minus its blurred
inverse. That leaves paper white where nothing changes while pulling out every
small shift in shading, which reads as finely worked graphite rather than a
threshold.

On its own the dodge leaves *every* flat area white however dark it really is,
so the shading is driven by the local brightness instead. That darkens the
paper and decides how many layers of cross hatching build up — one, two or
three, each fading in rather than switching on, so there is no banding where a
layer starts. Contours are measured across a single pixel to keep fine detail,
and a little grain stands in for paper.

The blur is separable, so the exporter does it as two passes (the second reads
the first through the auxiliary texture). A 2D Gaussian is separable, so the
preview does it in one pass and gets the same answer.

## Known limitations / next steps

- Preview decodes the source file in the webview; 8K HEVC may stutter.
  Planned: generate 2K proxies with ffmpeg for editing.
- Cuts only; no transitions yet.
- Filter settings are fixed for a clip; they cannot be keyframed.
- Presets store the filter chain only, not card or orientation settings.
- The filtered export is dominated by moving 4K frames through pipes rather
  than by the shaders. Keeping frames on the GPU, or using rgb24 instead of
  rgba, would be the place to look for more speed.
- Text cards do not move: they fade in and out, but cannot be animated along a
  path or keyframed.
- Spatial (ambisonic) audio passes through as plain multichannel AAC — no
  `SA3D` box yet.
- Reframe-to-flat (keyframed camera → 16:9) is not implemented.
