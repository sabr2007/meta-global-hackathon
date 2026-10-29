"""Mesh processing for scanned objects: a light visual mesh for the browser, convex colliders for
MuJoCo, and the geometry measures used to place and grade them."""

from __future__ import annotations

from dataclasses import dataclass

import fast_simplification
import numpy as np
import trimesh
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

VISUAL_FACES = 20_000  # raw SAM 3D meshes have ~800k faces, far too heavy for a browser scene
HULL_MAX_VERTICES = 96  # raw hulls reach ~3000 vertices; contact cost grows with them
BASE_CONE_DEG = 30.0  # convex hull faces this close to straight down form the base an object stands on
NEAREST_FACES = 16  # candidate triangles per point for exact point-to-surface distances
SURFACE_SAMPLES = 60_000  # dense enough for a 3 px z-buffer of a laptop-sized object in the photo
SAMPLE_SEED = 0
HOLE_GRID = 200  # cells across an object's footprint when looking for a hole straight through it
HOLE_MIN_FRACTION = 0.03  # smaller enclosed gaps in the footprint are mesh defects, not holes
RING_PIECES = 12  # convex pieces around a hole; each one bridges the hole's rim by under 4% of its radius
RING_OVERLAP_RAD = np.radians(4.0)  # neighbouring pieces overlap, so the ring has no seams to catch on


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


def farthest_points(points: np.ndarray, count: int) -> np.ndarray:
    """`count` of the points, spread out: the six axis extremes first, then farthest-point sampling."""
    points = np.asarray(points, dtype=np.float64)
    chosen = list(dict.fromkeys([*np.argmin(points, axis=0).tolist(), *np.argmax(points, axis=0).tolist()]))
    distance = np.min(np.linalg.norm(points[:, None, :] - points[chosen][None, :, :], axis=2), axis=1)
    while len(chosen) < min(count, len(points)):
        index = int(np.argmax(distance))
        chosen.append(index)
        distance = np.minimum(distance, np.linalg.norm(points - points[index], axis=1))
    return points[chosen]


def convex_hull(vertices: np.ndarray, max_vertices: int = HULL_MAX_VERTICES) -> tuple[np.ndarray, np.ndarray]:
    """Convex hull for collisions (MuJoCo collides meshes as hulls anyway) with at most max_vertices.

    The reduced hull is built from a subset of the true hull's vertices, so it never sticks out of
    the mesh (decimating the hull did: a laptop's collider reached 2.3 cm into the table)."""
    hull = trimesh.convex.convex_hull(np.asarray(vertices, dtype=np.float64))
    if len(hull.vertices) > max_vertices:
        hull = trimesh.convex.convex_hull(farthest_points(hull.vertices, max_vertices))
    return np.asarray(hull.vertices), np.asarray(hull.faces)


@dataclass(frozen=True)
class TopGrid:
    """A raster of the ground plane under an object, for looking down through it (rows y, columns x)."""

    low: np.ndarray  # world xy of the corner of cell (0, 0)
    cell: float  # metres per cell
    shape: tuple[int, int]

    @classmethod
    def around(cls, vertices: np.ndarray) -> TopGrid:
        xy = np.asarray(vertices, dtype=np.float64)[:, :2]
        cell = float(np.ptp(xy, axis=0).max()) / HOLE_GRID
        cols, rows = (np.ceil(np.ptp(xy, axis=0) / cell).astype(int) + 2).tolist()
        return cls(xy.min(axis=0), cell, (rows, cols))

    def cover(self, vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
        """Cells a mesh covers seen from straight above."""
        pixels = (np.asarray(vertices, dtype=np.float64)[:, :2] - self.low) / self.cell
        canvas = Image.new("1", self.shape[::-1], 0)
        draw = ImageDraw.Draw(canvas)
        for face in np.asarray(faces):
            draw.polygon([tuple(p) for p in pixels[face]], fill=1)
        return np.asarray(canvas, dtype=bool)

    def center(self, cells: np.ndarray) -> np.ndarray:
        rows, cols = np.nonzero(cells)
        return self.low + (np.array([cols.mean(), rows.mean()]) + 0.5) * self.cell


def through_hole(vertices: np.ndarray, faces: np.ndarray) -> tuple[TopGrid, np.ndarray] | None:
    """The largest hole straight down through a +Z-up mesh (the middle of a ring): its grid and cells."""
    grid = TopGrid.around(vertices)
    covered = grid.cover(vertices, faces)
    footprint = ndimage.binary_fill_holes(covered)
    holes, count = ndimage.label(footprint & ~covered)
    if count == 0:
        return None
    areas = np.bincount(holes.ravel())[1:]
    if areas.max() < HOLE_MIN_FRACTION * footprint.sum():
        return None
    return grid, holes == int(np.argmax(areas)) + 1


def ring_pieces(vertices: np.ndarray, center_xy: np.ndarray, count: int = RING_PIECES) -> list[tuple[np.ndarray, np.ndarray]]:
    """Convex colliders of a ring: its vertices in `count` overlapping sectors around the hole, each
    wrapped in a convex hull, so the hole stays open (one hull over the whole ring fills it)."""
    vertices = np.asarray(vertices, dtype=np.float64)
    angles = np.arctan2(vertices[:, 1] - center_xy[1], vertices[:, 0] - center_xy[0])
    width = 2 * np.pi / count
    pieces = []
    for i in range(count):
        offset = np.angle(np.exp(1j * (angles + np.pi - (i + 0.5) * width)))  # wrapped to (-pi, pi]
        chosen = vertices[np.abs(offset) <= width / 2 + RING_OVERLAP_RAD]
        if len(chosen) >= 4:
            pieces.append(convex_hull(chosen))
    return pieces


def collider_pieces(vertices: np.ndarray, faces: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """Convex pieces that keep a ring's hole open; empty when one convex hull is collider enough."""
    hole = through_hole(vertices, faces)
    return [] if hole is None else ring_pieces(vertices, hole[0].center(hole[1]))


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


def surface_samples(mesh: trimesh.Trimesh, count: int = SURFACE_SAMPLES) -> np.ndarray:
    """Area-uniform points on the surface (fixed seed, so reports and bakes repeat exactly)."""
    points, _ = trimesh.sample.sample_surface(mesh, count, seed=SAMPLE_SEED)
    return np.asarray(points, dtype=np.float64)


def up_axis(vertices: np.ndarray) -> np.ndarray:
    """The mesh's up axis: the normal of the base it stands on, i.e. minus the area-weighted mean
    normal of the convex hull faces that look down (within BASE_CONE_DEG of -Z)."""
    hull = trimesh.convex.convex_hull(np.asarray(vertices, dtype=np.float64))
    normals, areas = hull.face_normals, hull.area_faces
    down = normals[:, 2] < -np.cos(np.radians(BASE_CONE_DEG))
    if not down.any():
        return np.array([0.0, 0.0, 1.0])
    base = -(normals[down] * areas[down, None]).sum(axis=0)
    return base / np.linalg.norm(base)


def tilt_deg(up: np.ndarray) -> float:
    """Angle between a direction and +Z (the normal of every scanned table)."""
    up = np.asarray(up, dtype=np.float64)
    return float(np.degrees(np.arccos(np.clip(up[2] / np.linalg.norm(up), -1.0, 1.0))))


def surface_distances(vertices: np.ndarray, faces: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Distance from every point to the mesh surface (exact over the faces with the nearest centroids)."""
    triangles = np.asarray(vertices, dtype=np.float64)[np.asarray(faces)]
    points = np.asarray(points, dtype=np.float64)
    count = min(NEAREST_FACES, len(triangles))
    _, candidates = cKDTree(triangles.mean(axis=1)).query(points, k=count)
    queries = np.repeat(points, count, axis=0)
    closest = trimesh.triangles.closest_point(triangles[np.asarray(candidates).reshape(-1)], queries)
    return np.linalg.norm(closest - queries, axis=1).reshape(len(points), count).min(axis=1)
