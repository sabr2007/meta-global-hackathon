"""One look for every robot: graphite shells, neutral metal, lime for "ok", orange for "attention".

The palette is Ayna's design system (ios/Ayna/AynaDesign). MJCF colours are sRGB here; the web
viewer (web/src/render/armLook.ts) reads them as sRGB and adds the surface finish per material.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

PALETTE = {
    "graphite_900": "#1B1B1C",
    "graphite_800": "#252528",
    "graphite_600": "#3A3A3E",
    "neutral": "#B5B5BA",
    "lime": "#B8FF5E",
    "orange": "#EE7F35",
}


def _rgba(hex_color: str) -> str:
    value = hex_color.lstrip("#")
    r, g, b = (int(value[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return f"{r:.4g} {g:.4g} {b:.4g} 1"


# material name -> MJCF attributes; part materials name the role, not the colour
MATERIALS = {
    "robot_shell": {"rgba": _rgba(PALETTE["graphite_800"]), "specular": "0.4", "shininess": "0.6"},
    "robot_panel": {"rgba": _rgba(PALETTE["graphite_600"]), "specular": "0.4", "shininess": "0.6"},
    "robot_seal": {"rgba": _rgba(PALETTE["graphite_900"]), "specular": "0.2", "shininess": "0.3"},
    "robot_metal": {"rgba": _rgba(PALETTE["neutral"]), "specular": "0.6", "shininess": "0.7"},
    "robot_ok": {"rgba": _rgba(PALETTE["lime"]), "specular": "0.3", "shininess": "0.5", "emission": "0.25"},
    "robot_attention": {"rgba": _rgba(PALETTE["orange"]), "specular": "0.3", "shininess": "0.5", "emission": "0.25"},
}

# The status light is lime while a robot is fine; the app tints it orange when it reports a problem.
STATUS_OK = "robot_ok"
STATUS_ATTENTION = "robot_attention"


def add_materials(asset: ET.Element) -> None:
    """Add the robot materials to an <asset> once (several robots share them)."""
    present = {m.get("name") for m in asset.findall("material")}
    for name, attrs in MATERIALS.items():
        if name not in present:
            ET.SubElement(asset, "material", name=name, **attrs)
