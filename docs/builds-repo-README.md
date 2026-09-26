<!-- Paste this as the README of the public builds repo. It is kept here so
     the wording stays under version control with the thing it describes. -->

# Bubblecut — downloads

A desktop editor for 360° (equirectangular) video, built for research
recordings rather than for broadcast, with one-click export that plays
correctly in VR headsets and on YouTube/Vimeo 360.

**This repository holds released builds only.** The source is not currently
public.

## Download

Grab the latest from [Releases](../../releases).

- **macOS (Apple silicon):** `Bubblecut_*_aarch64.dmg`
- **Windows:** `Bubblecut_*_x64-setup.exe`, or the `.msi`

## FFmpeg is required and is not bundled

Bubblecut shells out to FFmpeg for every decode and encode. Install it first:

- macOS: `brew install ffmpeg`
- Windows: `winget install Gyan.FFmpeg`

The app checks on startup and shows the right command if it cannot find it.

On Apple silicon, make sure it is a native arm64 build. An Intel FFmpeg under
Rosetta cannot reach the hardware video encoder and exports roughly 20× slower
— measured at 0.16× realtime against 3.76× for the native build.

## First launch on macOS

The build is signed but not notarised, so macOS blocks it the first time with
"Apple could not verify Bubblecut is free of malware".

**System Settings** → **Privacy & Security** → scroll to the message about
Bubblecut → **Open Anyway**.

Or from a terminal:

```
xattr -dr com.apple.quarantine /Applications/Bubblecut.app
```

Control-clicking and choosing Open no longer works — Apple removed that bypass
for unnotarised apps in macOS 15.

## Citing

If Bubblecut contributes to published work, please cite it. See `CITATION.cff`
in the release assets, or cite the version and date of the build you used.

## Terms

© 2026 Jacob Davidsen · Big Soft Video · Aalborg University. All rights
reserved.

Image filters are based on 360mash (Big Soft Video, Aalborg University).
Decoding and encoding are done by FFmpeg, which you install yourself and which
is not distributed here.

Issues and questions: jdavidsen@ikk.aau.dk
