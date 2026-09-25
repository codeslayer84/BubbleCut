# Third-party software

Bubblecut is licensed under GPL-3.0-or-later. The licences below were read
from the installed packages rather than from memory; re-check them when
dependencies change.

## Needs resolving before public release

**360mash** — Big Soft Video, Aalborg University (<https://www.bigvideo.aau.dk/>)

The Grayscale, Pixelate, News Print, Charcoal, Cartoon, Monet and Painting
filters are ports of 360mash's WebGL fragment shaders, translated to WGSL for
the GPU exporter and reused as GLSL in the preview. 360mash's `package.json`
declares `"license": "UNLICENSED"` and `"private": true`, so it grants no
redistribution rights as it stands.

Publishing those filters under GPL-3.0 requires agreement from whoever holds
the copyright in 360mash — which may include co-authors and Aalborg
University, not only this project's author. This is a rights question, not a
licence-compatibility one: a licence can only be granted by the rights holder.

The Van Gogh, Watercolour and Pencil Drawing filters are original to this
project and are not affected.

## FFmpeg — invoked, not linked

<https://ffmpeg.org/>

Bubblecut runs `ffmpeg` and `ffprobe` as separate processes and does not link
against their libraries, so no FFmpeg code is distributed with it today and
FFmpeg's licence does not reach this project's own code.

Bundling it was considered and deliberately not done. Doing so would mean
redistributing FFmpeg under its own terms — with a GPL build, an obligation to
offer that build's corresponding source — and the convenient prebuilt packages
turn out to be configured `--enable-nonfree`, which may not be redistributed at
all. Instead the app checks for FFmpeg at startup and tells the user how to
install it.

If it is ever bundled, FFmpeg's own terms apply from that moment. A build
configured with `--enable-gpl --enable-version3` — as the Homebrew build on
the development machine is — is GPL-3.0, which is compatible with this
project's GPL-3.0, but it obliges you to offer the corresponding source for
that build. A build without `--enable-gpl` is LGPL and less demanding.

Never bundle a build configured with `--enable-nonfree`: it may not be
redistributed at all.

## Bundled libraries

All permissive; none place requirements on this project's licence beyond
keeping their copyright notices.

| Component | Licence |
|---|---|
| Tauri, tauri-build, tauri-plugin-{opener,dialog,fs} | Apache-2.0 OR MIT |
| `@tauri-apps/api`, `@tauri-apps/cli`, `@tauri-apps/plugin-{dialog,fs,opener}` | Apache-2.0 OR MIT |
| wgpu | MIT OR Apache-2.0 |
| serde, serde_json | MIT OR Apache-2.0 |
| thiserror | MIT OR Apache-2.0 |
| uuid | Apache-2.0 OR MIT |
| base64 | MIT OR Apache-2.0 |
| pollster | Apache-2.0 OR MIT |
| bytemuck | Zlib OR Apache-2.0 OR MIT |
| React, react-dom | MIT |
| three.js | MIT |
| zustand | MIT |

## Build-time only

Not distributed with the application.

| Component | Licence |
|---|---|
| Vite, `@vitejs/plugin-react` | MIT |
| TypeScript | Apache-2.0 |
| `@types/*` (DefinitelyTyped) | MIT |

## Specifications

- **Spherical Video V2** (Google) — the `st3d` and `sv3d` box layout written
  into exported MP4s. A specification, implemented independently here; no
  Google code is used.
- **CAVA360VR** — Aalborg University. The card sidecar is written for it; no
  CAVA code is included in this project.
