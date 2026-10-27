"""Prepare capture photos for vision models.

Photos are stored in sensor orientation with an EXIF rotation tag, and the
capture intrinsics refer to those raw sensor pixels. Models see the photo
upright; `UprightImage.to_sensor` maps their pixel coordinates back so masks
can later be lifted to 3D with the original camera intrinsics.
"""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

EXIF_ORIENTATION_TAG = 274
JPEG_QUALITY = 90

# EXIF orientation -> number of 90-degree clockwise turns that make the photo upright.
_CLOCKWISE_TURNS = {1: 0, 6: 1, 3: 2, 8: 3}


@dataclass(frozen=True)
class UprightImage:
    image: Image.Image  # upright RGB, possibly downscaled
    sensor_size: tuple[int, int]  # (width, height) of the raw sensor image
    clockwise_turns: int
    scale: float  # upright pixels per raw sensor pixel

    def data_url(self) -> str:
        buffer = io.BytesIO()
        self.image.save(buffer, "JPEG", quality=JPEG_QUALITY)
        return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    def to_sensor(self, xy: np.ndarray) -> np.ndarray:
        """Map (N, 2) upright pixel coordinates to raw sensor pixel coordinates."""
        pts = np.asarray(xy, dtype=np.float64) / self.scale
        w, h = self.sensor_size
        x, y = pts[:, 0], pts[:, 1]
        if self.clockwise_turns == 0:
            sx, sy = x, y
        elif self.clockwise_turns == 1:  # upright (x, y) came from sensor (y, h - x)
            sx, sy = y, h - x
        elif self.clockwise_turns == 2:
            sx, sy = w - x, h - y
        else:
            sx, sy = w - y, x
        return np.column_stack([sx, sy])

    def from_sensor(self, xy: np.ndarray) -> np.ndarray:
        """Map (N, 2) raw sensor pixel coordinates to upright (possibly scaled) pixel coordinates."""
        pts = np.asarray(xy, dtype=np.float64)
        w, h = self.sensor_size
        sx, sy = pts[:, 0], pts[:, 1]
        if self.clockwise_turns == 0:
            x, y = sx, sy
        elif self.clockwise_turns == 1:
            x, y = h - sy, sx
        elif self.clockwise_turns == 2:
            x, y = w - sx, h - sy
        else:
            x, y = sy, w - sx
        return np.column_stack([x, y]) * self.scale


def load_upright(path: Path, max_side: int | None = None) -> UprightImage:
    raw = Image.open(path)
    orientation = raw.getexif().get(EXIF_ORIENTATION_TAG, 1)
    if orientation not in _CLOCKWISE_TURNS:
        raise ValueError(f"{path}: unsupported EXIF orientation {orientation}")
    sensor_size = raw.size
    upright = ImageOps.exif_transpose(raw).convert("RGB")
    scale = 1.0
    if max_side is not None and max(upright.size) > max_side:
        scale = max_side / max(upright.size)
        upright = upright.resize((round(upright.width * scale), round(upright.height * scale)), Image.LANCZOS)
    return UprightImage(image=upright, sensor_size=sensor_size, clockwise_turns=_CLOCKWISE_TURNS[orientation], scale=scale)
