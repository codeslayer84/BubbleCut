#!/usr/bin/env python3
"""Draws the app icon and writes raw RGBA for ffmpeg to encode.

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


def ellipse_distance(x, y, cx, cy, rx, ry):
    """First-order distance to an ellipse outline; good enough for a stroke."""
    dx = (x - cx) / rx
    dy = (y - cy) / ry
    f = dx * dx + dy * dy - 1.0
    gx = 2.0 * (x - cx) / (rx * rx)
    gy = 2.0 * (y - cy) / (ry * ry)
    grad = math.hypot(gx, gy)
    return f / grad if grad > 1e-9 else 1e9


def in_triangle(px, py, a, b, c):
    def side(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    p = (px, py)
    d1, d2, d3 = side(p, a, b), side(p, b, c), side(p, c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def sample(x, y, S):
    """Colour and alpha at one sample point, or None outside the plate."""
    # Rounded-square plate.
    r = S * 0.225
    half = S / 2.0
    qx = abs(x - half) - (half - r)
    qy = abs(y - half) - (half - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0)) - r
    if outside > 0.0:
        return None

    col = mix(PLATE_TOP, PLATE_BOTTOM, y / S)

    cx = cy = half
    R = S * 0.315
    rim_half = S * 0.009
    line_half = S * 0.008

    d_centre = math.hypot(x - cx, y - cy)
    if d_centre <= R + rim_half:
        if d_centre <= R:
            t = ((x - (cx - R)) + (y - (cy - R))) / (4.0 * R)
            col = mix(SPHERE_A, SPHERE_B, min(max(t, 0.0), 1.0))

            # Latitudes, flattened by perspective.
            on_line = False
            for lat in (-40.0, 0.0, 40.0):
                rad = math.radians(lat)
                ey = cy + R * math.sin(rad)
                erx = R * math.cos(rad)
                ery = max(R * 0.20 * math.cos(rad), S * 0.012)
                if abs(ellipse_distance(x, y, cx, ey, erx, ery)) <= line_half:
                    on_line = True
                    break
            # Meridians, narrowing towards the centre.
            if not on_line:
                for f in (1.0, 0.55):
                    if abs(ellipse_distance(x, y, cx, cy, R * f, R)) <= line_half:
                        on_line = True
                        break
            if not on_line and abs(x - cx) <= line_half:
                on_line = True
            if on_line:
                col = over(col, (255, 255, 255), 0.5)

        # Rim.
        if abs(d_centre - R) <= rim_half:
            col = over(col, (255, 255, 255), 0.75)

    # Play badge, so it reads as video rather than a globe.
    pr = R * 0.52
    px = cx + R * 0.62
    py = cy + R * 0.62
    if math.hypot(x - px, y - py) <= pr:
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
