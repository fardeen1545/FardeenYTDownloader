"""Generate the extension's PNG icons from the same geometry as docs/logo.svg.

Red gradient rounded square with a white "download into tray" glyph and a soft shadow.
Rendered with signed-distance functions, so edges are anti-aliased at every size.
Pure standard library:  python tools/make_icons.py
"""
import math
import os
import struct
import zlib

SIZES = (16, 32, 48, 128)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")

# Geometry in unit coordinates (0..1). Keep in sync with docs/logo.svg (viewBox 0 0 128 128).
INSET = 0.03
RADIUS = 0.23
TOP_COLOR = (255, 78, 69)      # #FF4E45
BOTTOM_COLOR = (214, 18, 11)   # #D6120B
SHADOW_COLOR = (120, 0, 0)
SHADOW_OFFSET = 0.025
SHADOW_ALPHA = 0.35
SHADOW_SHARPNESS = 40
STROKES = [  # polylines drawn with round caps and joins
    [(0.50, 0.22), (0.50, 0.58)],                    # arrow shaft
    [(0.33, 0.43), (0.50, 0.60), (0.67, 0.43)],      # arrow head
    [(0.25, 0.64), (0.25, 0.78), (0.75, 0.78), (0.75, 0.64)],  # tray
]


def stroke_half_width(size):
    """Thicker strokes at tiny sizes so the glyph stays legible in the toolbar."""
    return 0.075 if size <= 16 else 0.065 if size <= 32 else 0.055


def sd_rounded_rect(x, y):
    half = 0.5 - INSET
    qx = abs(x - 0.5) - (half - RADIUS)
    qy = abs(y - 0.5) - (half - RADIUS)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    return outside + min(max(qx, qy), 0.0) - RADIUS


def sd_segment(x, y, ax, ay, bx, by):
    px, py, dx, dy = x - ax, y - ay, bx - ax, by - ay
    t = max(0.0, min(1.0, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - dx * t, py - dy * t)


def sd_glyph(x, y, half_width):
    best = min(sd_segment(x, y, *a, *b) for line in STROKES for a, b in zip(line, line[1:]))
    return best - half_width


def coverage(distance, size):
    """Signed distance (unit coords) -> pixel coverage with a 1px anti-aliased edge."""
    return max(0.0, min(1.0, 0.5 - distance * size))


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def pixel(px, py, size):
    x, y = (px + 0.5) / size, (py + 0.5) / size
    shape = coverage(sd_rounded_rect(x, y), size)
    if not shape:
        return 0, 0, 0, 0
    half_width = stroke_half_width(size)
    color = mix(TOP_COLOR, BOTTOM_COLOR, y)
    shadow_sharpness = min(size, SHADOW_SHARPNESS)  # soft edge ~1/40 of the icon wide
    shadow = coverage(sd_glyph(x, y - SHADOW_OFFSET, half_width), shadow_sharpness) * SHADOW_ALPHA
    color = mix(color, SHADOW_COLOR, shadow)
    color = mix(color, (255, 255, 255), coverage(sd_glyph(x, y, half_width), size))
    return tuple(round(c) for c in color) + (round(shape * 255),)


def png_bytes(size):
    rows = b"".join(
        b"\x00" + b"".join(bytes(pixel(x, y, size)) for x in range(size)) for y in range(size))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        with open(path, "wb") as fh:
            fh.write(png_bytes(size))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
