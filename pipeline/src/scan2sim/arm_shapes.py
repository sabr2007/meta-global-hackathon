"""Procedural shell shapes for the arm: rounded drums and boxes, joined by convex hulls.

Every part of the arm is the convex hull of a few of these point clouds, which gives smooth,
cast-looking housings and a shape MuJoCo can collide directly (it collides meshes as hulls).
"""

from __future__ import annotations

import numpy as np
import trimesh

SEGMENTS = 64  # points around a drum; the hull is smooth at this count
BEVEL_STEPS = 6  # points along each rounded edge


def _frame(axis: np.ndarray) -> np.ndarray:
    """Orthonormal basis (columns u, v, axis) for a unit axis."""
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    helper = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
    u = np.cross(axis, helper)
    u /= np.linalg.norm(u)
    return np.column_stack([u, np.cross(axis, u), axis])


def drum(
    center,
    axis,
    radius: float,
    start: float,
    end: float,
    bevel_start: float = 0.0,
    bevel_end: float = 0.0,
    segments: int = SEGMENTS,
) -> np.ndarray:
    """Points of a cylinder along `axis` from `start` to `end` (offsets from `center`),
    each end rounded with its own bevel radius (0 = sharp edge)."""
    basis = _frame(axis)
    angles = np.linspace(0.0, 2 * np.pi, segments, endpoint=False)
    ring = np.column_stack([np.cos(angles), np.sin(angles)])
    profile = []  # (radial distance, axial offset)
    for bevel, z, inward in ((bevel_start, start, 1.0), (bevel_end, end, -1.0)):
        if bevel <= 0.0:
            profile.append((radius, z))
            continue
        for t in np.linspace(0.0, np.pi / 2, BEVEL_STEPS):
            profile.append((radius - bevel + bevel * np.cos(t), z + inward * (bevel - bevel * np.sin(t))))
    points = [
        np.column_stack([ring * rho, np.full(segments, z)]) for rho, z in profile
    ]
    local = np.vstack(points)
    return np.asarray(center, dtype=np.float64) + local @ basis.T


def rounded_box(center, half_size, radius: float, rotation=None) -> np.ndarray:
    """Points of a box with rounded edges and corners (Minkowski sum of a box and a sphere)."""
    half = np.asarray(half_size, dtype=np.float64) - radius
    if (half < 0).any():
        raise ValueError(f"corner radius {radius} exceeds half size {half_size}")
    sphere = trimesh.creation.icosphere(subdivisions=2, radius=radius).vertices
    corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * half
    local = (corners[:, None, :] + sphere[None, :, :]).reshape(-1, 3)
    rotation = np.eye(3) if rotation is None else np.asarray(rotation, dtype=np.float64)
    return np.asarray(center, dtype=np.float64) + local @ rotation.T


def hull(*clouds: np.ndarray) -> trimesh.Trimesh:
    """Convex hull of the union of point clouds, outward-facing triangles."""
    return trimesh.convex.convex_hull(np.vstack(clouds))
