"""Make the two static Doto instances the app ships (fonts/ofl/doto in github.com/google/fonts).

Doto is a variable font (axes ROND 0-100, wght 100-900). SwiftUI picks custom fonts by
PostScript name, so instead of driving variation axes at runtime the app bundles two static
instances with round dots (ROND=100, like LiDAR points):

    Doto-Bold.ttf   wght=700   PostScript name Doto-Bold
    Doto-Black.ttf  wght=900   PostScript name Doto-Black

Usage: python make_doto_static.py "Doto[ROND,wght].ttf" <output folder>
Requires fonttools.
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROUND_DOTS = 100.0

# (file stem, wght, name 1 family, name 2 subfamily, typographic family/subfamily or None)
STYLES = [
    ("Doto-Bold", 700, "Doto", "Bold", None),
    ("Doto-Black", 900, "Doto Black", "Regular", ("Doto", "Black")),
]


def set_name(font: TTFont, name_id: int, value: str) -> None:
    font["name"].setName(value, name_id, 3, 1, 0x409)  # Windows, Unicode BMP, en-US
    font["name"].setName(value, name_id, 1, 0, 0)  # Macintosh, Roman, English


def make(source: Path, out_dir: Path) -> None:
    for stem, weight, family, subfamily, typographic in STYLES:
        font = instancer.instantiateVariableFont(TTFont(source), {"ROND": ROUND_DOTS, "wght": weight})
        name = font["name"]
        for record in list(name.names):
            if record.nameID in (1, 2, 3, 4, 6, 16, 17, 25):
                name.removeNames(nameID=record.nameID)
        full = f"Doto {typographic[1] if typographic else subfamily}"
        set_name(font, 1, family)
        set_name(font, 2, subfamily)
        set_name(font, 3, f"{stem};static ROND={ROUND_DOTS:g} wght={weight}")
        set_name(font, 4, full)
        set_name(font, 6, stem)
        if typographic:
            set_name(font, 16, typographic[0])
            set_name(font, 17, typographic[1])
        os2 = font["OS/2"]
        os2.usWeightClass = weight
        bold = subfamily == "Bold"
        os2.fsSelection = (os2.fsSelection & ~0b1100001) | (0b100000 if bold else 0b1000000)  # BOLD / REGULAR bits
        font["head"].macStyle = 1 if bold else 0
        path = out_dir / f"{stem}.ttf"
        font.save(path)
        print(f"{path.name}: PostScript name {stem}, wght {weight}, ROND {ROUND_DOTS:g}")


if __name__ == "__main__":
    make(Path(sys.argv[1]), Path(sys.argv[2]))
