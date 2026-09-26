import { useEffect, useRef } from "react";
import { useStore } from "../lib/store";
import { mediaUrl } from "../lib/tauri";
import type { AudioTrack } from "../lib/types";

/** Where the playhead sits inside a track, and how loud it should be there. */
function levelAt(t: AudioTrack, playhead: number): number | null {
  const len = t.outPoint - t.inPoint;
  const into = playhead - t.start;
  if (into < 0 || into > len) return null;
  let f = 1;
  if (t.fadeIn > 0 && into < t.fadeIn) f = into / t.fadeIn;
  if (t.fadeOut > 0 && into > len - t.fadeOut) f = Math.min(f, (len - into) / t.fadeOut);
  // The element's volume tops out at 1, so a boosted track is previewed
  // quieter than it exports. The export applies the real figure.
  return Math.max(0, Math.min(1, t.gain * f));
}

function OneTrack({ track }: { track: AudioTrack }) {
  const el = useRef<HTMLAudioElement>(null);
  const media = useStore((s) => s.media[track.mediaPath]);
  const playing = useStore((s) => s.playing);
  const playhead = useStore((s) => s.playhead);

  useEffect(() => {
    const a = el.current;
    if (!a) return;
    const level = levelAt(track, playhead);
    if (level === null) {
      a.volume = 0; // so a play() racing this cannot blip
      if (!a.paused) a.pause();
      return;
    }
    a.volume = level;
    const want = track.inPoint + (playhead - track.start);
    // Only chase the playhead when it has genuinely drifted: assigning
    // currentTime every frame stutters the sound.
    if (Math.abs(a.currentTime - want) > 0.15) a.currentTime = want;
    if (playing && a.paused) a.play().catch(() => {});
    if (!playing && !a.paused) a.pause();
  }, [track, playhead, playing]);

  if (!media) return null;
  return <audio ref={el} src={mediaUrl(media)} preload="auto" />;
}

/**
 * Plays the audio lane alongside the viewer. Headless — the viewer owns the
 * playhead and this follows it, rather than the other way round, because the
 * video element is what the timeline is already slaved to.
 */
export function AudioPreview() {
  const audio = useStore((s) => s.audio);
  return (
    <>
      {audio.map((t) => (
        <OneTrack key={t.id} track={t} />
      ))}
    </>
  );
}
