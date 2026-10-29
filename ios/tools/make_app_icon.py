"""Render the Ayna app icon: a light-grey Michroma "A" over its dot-matrix (Doto) reflection
on graphite. 1024x1024, opaque RGB (App Store icons must not have an alpha channel).

Usage: python make_app_icon.py [output.png]
Default output: ../Ayna/Assets.xcassets/AppIcon.appiconset/AppIcon.png (relative to this file).
Requires Pillow; uses the fonts bundled in ../Ayna/Fonts.
"""

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
FONTS = HERE.parent / "Ayna" / "Fonts"
DEFAULT_OUT = HERE.parent / "Ayna" / "Assets.xcassets" / "AppIcon.appiconset" / "AppIcon.png"

SIZE = 1024
GRAPHITE_CENTER = (42, 42, 46)  # a touch lighter in the middle
GRAPHITE_EDGE = (27, 27, 28)  # #1B1B1C, the app background
LETTER = (181, 181, 186)  # #B5B5BA, Ayna's neutral grey
REFLECTION = (85, 85, 90)  # #55555A, same as the logo's mirrored word

CAP_HEIGHT = 330  # px, height of the solid A
GAP = 30  # px between the A's baseline and its reflection
FADE_TO = 0.55  # reflection opacity at its far end (1 at the baseline)
SUPERSAMPLE = 4


def background(size: int) -> Image.Image:
    """Soft radial graphite: edge colour at the corners, slightly lighter centre."""
    small = 256
    img = Image.new("RGB", (small, small))
    px = img.load()
    c = (small - 1) / 2
    max_d = (2 * c * c) ** 0.5
    for y in range(small):
        for x in range(small):
            t = min(1.0, (((x - c) ** 2 + (y - c) ** 2) ** 0.5) / max_d)
            t = t * t * (3 - 2 * t)  # smoothstep
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(GRAPHITE_CENTER, GRAPHITE_EDGE))
    return img.resize((size, size), Image.Resampling.BICUBIC)


def glyph(font_path: Path, cap_ratio: float, cap_px: int, color: tuple[int, int, int]) -> Image.Image:
    """The letter A, cropped to its ink, with cap height `cap_px` (at supersampled scale)."""
    font = ImageFont.truetype(str(font_path), round(cap_px / cap_ratio))
    left, top, right, bottom = font.getbbox("A")
    canvas = Image.new("L", (right - left + 8, bottom - top + 8), 0)
    ImageDraw.Draw(canvas).text((4 - left, 4 - top), "A", font=font, fill=255)
    mask = canvas.crop(canvas.getbbox())
    tile = Image.new("RGBA", mask.size, color + (255,))
    tile.putalpha(mask)
    return tile


def render(out: Path) -> None:
    s = SUPERSAMPLE
    big = SIZE * s
    icon = background(big).convert("RGBA")
    solid = glyph(FONTS / "Michroma-Regular.ttf", 0.75, CAP_HEIGHT * s, LETTER)  # Michroma cap height 0.75 em
    dots = glyph(FONTS / "Doto-Black.ttf", 0.70, CAP_HEIGHT * s, REFLECTION)  # Doto cap height 0.70 em
    mirrored = ImageOps.flip(dots)
    # like a reflection on a table: strongest at the baseline, fading away from it
    fade = Image.linear_gradient("L").resize(mirrored.size).point(lambda v: round(255 - v * (1 - FADE_TO)))
    mirrored.putalpha(ImageChops.multiply(mirrored.getchannel("A"), fade))
    total = solid.height + GAP * s + mirrored.height
    top = (big - total) // 2
    icon.alpha_composite(solid, ((big - solid.width) // 2, top))
    icon.alpha_composite(mirrored, ((big - mirrored.width) // 2, top + solid.height + GAP * s))
    final = icon.convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    final.save(out, optimize=True)
    print(f"wrote {out} ({final.size[0]}x{final.size[1]}, {final.mode})")


if __name__ == "__main__":
    render(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT)
