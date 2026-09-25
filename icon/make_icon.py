#!/usr/bin/env python3
"""Draws the Bubblecut icon and writes raw RGBA for ffmpeg to encode.

Kept as a script rather than a checked-in binary so the icon can be adjusted
and regenerated. No image library is installed on this machine, so the pixels
are computed directly and antialiased by supersampling.

    python3 icon/make_icon.py 1024 icon/icon.raw
    ffmpeg -f rawvideo -pix_fmt rgba -s 1024x1024 -i icon/icon.raw icon/icon.png
"""
import math
import sys

SS = 3  # supersamples per axis

PLATE_TOP = (34, 42, 59)
PLATE_BOTTOM = (13, 16, 23)
SPHERE_A = (106, 168, 255)
SPHERE_B = (39, 216, 189)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c0, c1, t):
    return (lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t))


def over(dst, src, alpha):
    """Source-over composite of an opaque colour at `alpha`."""
    return (lerp(dst[0], src[0], alpha),
            lerp(dst[1], src[1], alpha),
            lerp(dst[2], src[2], alpha))


def in_triangle(px, py, a, b, c):
    def side(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    p = (px, py)
    d1, d2, d3 = side(p, a, b), side(p, b, c), side(p, c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def smoothstep(a, b, x):
    if b == a:
        return 0.0 if x < a else 1.0
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


# Soap-film iridescence: the colour a bubble shows depends on where you look
# at it, so the hue is taken round the bubble rather than being flat.
FILM = [
    (0.00, (124, 196, 255)),
    (0.28, (111, 242, 208)),
    (0.50, (255, 226, 122)),
    (0.72, (255, 154, 224)),
    (1.00, (124, 196, 255)),
]


def film_colour(t):
    t = t % 1.0
    for i in range(len(FILM) - 1):
        t0, c0 = FILM[i]
        t1, c1 = FILM[i + 1]
        if t0 <= t <= t1:
            return mix(c0, c1, (t - t0) / (t1 - t0))
    return FILM[-1][1]


def bubble(x, y, bx, by, br):
    """Colour and coverage of one bubble, or None outside it."""
    dx = x - bx
    dy = y - by
    d = math.hypot(dx, dy) / br
    if d > 1.0:
        return None

    ang = math.atan2(dy, dx)
    col = film_colour(ang / (2.0 * math.pi) + 0.5 + 0.35 * d)

    # A bubble is a thin film: you see almost nothing through the middle and
    # a bright ring where the film is edge-on.
    rim = smoothstep(0.55, 1.0, d)
    col = mix(col, (255, 255, 255), 0.45 * rim)
    # Enough film to carry its colour against a dark plate; a physically
    # fainter bubble just turns to mud at icon sizes.
    alpha = 0.34 + 0.62 * rim

    # The highlight is what actually makes it read as a bubble.
    hd = math.hypot(x - (bx - 0.42 * br), y - (by - 0.46 * br)) / (0.30 * br)
    if hd < 1.0:
        k = (1.0 - hd) ** 2
        col = mix(col, (255, 255, 255), 0.90 * k)
        alpha += (1.0 - alpha) * 0.85 * k
    gd = math.hypot(x - (bx + 0.40 * br), y - (by + 0.44 * br)) / (0.17 * br)
    if gd < 1.0:
        k = (1.0 - gd) ** 2
        col = mix(col, (255, 255, 255), 0.70 * k)
        alpha += (1.0 - alpha) * 0.55 * k

    return col, min(alpha, 1.0)


def sample(x, y, S):
    """Colour and alpha at one sample point, or None outside the plate."""
    r = S * 0.225
    half = S / 2.0
    qx = abs(x - half) - (half - r)
    qy = abs(y - half) - (half - r)
    if math.hypot(max(qx, 0.0), max(qy, 0.0)) - r > 0.0:
        return None

    col = mix(PLATE_TOP, PLATE_BOTTOM, y / S)

    # Back to front, so the overlaps read correctly.
    for bx, by, br in (
        (0.255 * S, 0.735 * S, 0.105 * S),
        (0.720 * S, 0.275 * S, 0.135 * S),
        (0.445 * S, 0.470 * S, 0.300 * S),
    ):
        hit = bubble(x, y, bx, by, br)
        if hit is not None:
            col = over(col, hit[0], hit[1])

    # Play badge, so it reads as video rather than decoration.
    pr = S * 0.150
    px = S * 0.715
    py = S * 0.715
    pd = math.hypot(x - px, y - py)
    if pd <= pr:
        col = (255, 255, 255)
        t = pr * 0.52
        a = (px - t * 0.55, py - t)
        b = (px + t * 0.85, py)
        c = (px - t * 0.55, py + t)
        if in_triangle(x, y, a, b, c):
            col = (18, 22, 31)

    return col


def main():
    S = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
    out_path = sys.argv[2] if len(sys.argv) > 2 else "icon.raw"
    step = 1.0 / SS
    offset = step / 2.0
    n = SS * SS
    buf = bytearray()
    for py in range(S):
        row = bytearray()
        for px in range(S):
            r = g = b = a = 0.0
            for sy in range(SS):
                yy = py + offset + sy * step
                for sx in range(SS):
                    xx = px + offset + sx * step
                    s = sample(xx, yy, S)
                    if s is not None:
                        r += s[0]; g += s[1]; b += s[2]; a += 255.0
            if a > 0.0:
                # Straight (unassociated) alpha: average colour over covered
                # samples only, so edges do not darken towards black.
                covered = a / 255.0
                row += bytes((int(r / covered + 0.5), int(g / covered + 0.5),
                              int(b / covered + 0.5), int(a / n + 0.5)))
            else:
                row += b"\x00\x00\x00\x00"
        buf += row
        if py % 128 == 0:
            print(f"row {py}/{S}", flush=True)
    with open(out_path, "wb") as f:
        f.write(buf)
    print("done", out_path, len(buf))


if __name__ == "__main__":
    main()
