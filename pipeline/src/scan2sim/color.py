"""Colour conversions for comparing meshes with photos: sRGB (0-255) -> linear RGB -> CIELAB (D65)."""

from __future__ import annotations

import numpy as np

SRGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
D65_WHITE = np.array([0.95047, 1.0, 1.08883])
LAB_EPSILON = 216 / 24389
LAB_KAPPA = 24389 / 27


def srgb_to_linear(rgb: np.ndarray) -> np.ndarray:
    """sRGB values 0-255 -> linear light 0-1."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """(..., 3) sRGB values 0-255 -> CIELAB (L 0-100) under D65."""
    xyz = srgb_to_linear(rgb) @ SRGB_TO_XYZ.T / D65_WHITE
    f = np.where(xyz > LAB_EPSILON, np.cbrt(xyz), (LAB_KAPPA * xyz + 16) / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def delta_e(lab_a: np.ndarray, lab_b: np.ndarray) -> np.ndarray:
    """CIE76 colour difference: about 2 is just noticeable, above 10 reads as another colour."""
    return np.linalg.norm(np.asarray(lab_a, dtype=np.float64) - np.asarray(lab_b, dtype=np.float64), axis=-1)
