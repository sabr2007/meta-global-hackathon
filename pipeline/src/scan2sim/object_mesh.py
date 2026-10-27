"""Mesh processing for scanned objects: a light visual mesh for the browser, a convex collider for MuJoCo."""

from __future__ import annotations

import fast_simplification
import numpy as np
import trimesh
from scipy.spatial import cKDTree

VISUAL_FACES = 20_000  # raw SAM 3D meshes have ~800k faces, far too heavy for a browser scene
HULL_MAX_VERTICES = 96  # raw hulls reach ~3000 vertices; contact cost grows with them


def simplify(mesh: trimesh.Trimesh, target_faces: int = VISUAL_FACES) -> trimesh.Trimesh:
    """Quadric decimation; vertex colours are carried over from the nearest original vertex."""
    colors = np.asarray(mesh.visual.vertex_colors)
    if len(mesh.faces) <= target_faces:
        return trimesh.Trimesh(mesh.vertices.copy(), mesh.faces.copy(), vertex_colors=colors.copy(), process=False)
    points, faces = fast_simplification.simplify(
        np.asarray(mesh.vertices, dtype=np.float64),
        np.asarray(mesh.faces, dtype=np.int32),
        target_count=target_faces,
    )
    _, nearest = cKDTree(mesh.vertices).query(points)
    return trimesh.Trimesh(points, faces, vertex_colors=colors[nearest], process=False)


def convex_hull(vertices: np.ndarray, max_vertices: int = HULL_MAX_VERTICES) -> tuple[np.ndarray, np.ndarray]:
    """Convex hull for collisions (MuJoCo collides meshes as hulls anyway), decimated to max_vertices."""
    hull = trimesh.convex.convex_hull(np.asarray(vertices, dtype=np.float64))
    if len(hull.vertices) > max_vertices:
        # A closed triangle mesh has about 2V faces; re-hull the decimated points to stay convex.
        points, _ = fast_simplification.simplify(
            np.asarray(hull.vertices, dtype=np.float64),
            np.asarray(hull.faces, dtype=np.int32),
            target_count=2 * max_vertices - 4,
        )
        hull = trimesh.convex.convex_hull(points)
    return np.asarray(hull.vertices), np.asarray(hull.faces)


def oriented_size(vertices: np.ndarray) -> np.ndarray:
    """Length, width (principal axes in the ground plane) and height of a +Z-up point set."""
    points = np.asarray(vertices, dtype=np.float64)
    xy = points[:, :2] - points[:, :2].mean(axis=0)
    _, _, axes = np.linalg.svd(xy, full_matrices=False)
    local = xy @ axes.T
    return np.array([*np.ptp(local, axis=0), np.ptp(points[:, 2])])


def mean_color(mesh: trimesh.Trimesh) -> tuple[float, float, float, float]:
    rgb = np.asarray(mesh.visual.vertex_colors)[:, :3].mean(axis=0) / 255.0
    return (float(rgb[0]), float(rgb[1]), float(rgb[2]), 1.0)
