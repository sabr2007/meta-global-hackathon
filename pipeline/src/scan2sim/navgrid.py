"""The floor as a robot base sees it: RoomPlan footprints, the scanned floor outline, clearance.

web/src/sim/navigation.ts plans paths on the same model (5 cm cells, obstacles = colliding
elements below the robot's height, doors and windows free); this module only needs clearance to
pick where the mobile manipulator starts.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from scan2sim.scene import Box

CELL_M = 0.05
MAX_OBSTACLE_BOTTOM_M = 1.6  # a shelf higher than this does not block a robot base


@dataclass(frozen=True)
class Footprint:
    """An element seen from above: oriented rectangle (centre, unit axis u, half sizes along u, v)."""

    name: str
    center: np.ndarray  # world xy
    u: np.ndarray  # unit xy direction of the first half size
    half: np.ndarray  # half sizes along u and its perpendicular


def box_footprint(box: Box) -> Footprint:
    vertical = int(np.argmax(np.abs(box.rotation[2])))  # local axis that points up in the world
    a, b = (i for i in range(3) if i != vertical)
    u = box.rotation[:2, a]
    return Footprint(box.name, box.center[:2].copy(), u / np.linalg.norm(u), np.array([box.half_size[a], box.half_size[b]]))


def box_bottom(box: Box) -> float:
    corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
    return float((box.center + (corners * box.half_size) @ box.rotation.T)[:, 2].min())


def obstacles(boxes: tuple[Box, ...]) -> list[Footprint]:
    """Footprints a robot base must keep out of: walls and furniture (tables included)."""
    return [box_footprint(b) for b in boxes if b.collides and box_bottom(b) < MAX_OBSTACLE_BOTTOM_M]


def footprint_distance(footprint: Footprint, points: np.ndarray) -> np.ndarray:
    """Horizontal distance from (N, 2) points to the rectangle (0 inside)."""
    d = np.asarray(points, dtype=np.float64) - footprint.center
    v = np.array([-footprint.u[1], footprint.u[0]])
    outside = np.abs(np.column_stack([d @ footprint.u, d @ v])) - footprint.half
    return np.linalg.norm(np.maximum(outside, 0.0), axis=1)


def inside_polygon(points: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    """Even-odd rule for (N, 2) points in a closed polygon (K, 2)."""
    px, py = np.asarray(points, dtype=np.float64).T
    inside = np.zeros(len(px), dtype=bool)
    for (x1, y1), (x2, y2) in zip(polygon, np.roll(polygon, -1, axis=0)):
        crosses = (y1 > py) != (y2 > py)
        with np.errstate(divide="ignore", invalid="ignore"):
            x_at = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
        inside ^= crosses & (px < x_at)
    return inside


def polygon_edge_distance(points: np.ndarray, polygon: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float64)
    best = np.full(len(pts), np.inf)
    for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
        ab = b - a
        t = np.clip(((pts - a) @ ab) / max(float(ab @ ab), 1e-12), 0.0, 1.0)
        best = np.minimum(best, np.linalg.norm(pts - (a + t[:, None] * ab), axis=1))
    return best


def clearance(points: np.ndarray, footprints: list[Footprint], floor: np.ndarray | None) -> np.ndarray:
    """Free distance around each point: to the nearest obstacle or the floor outline (0 outside the floor)."""
    pts = np.asarray(points, dtype=np.float64)
    free = np.full(len(pts), np.inf)
    for footprint in footprints:
        free = np.minimum(free, footprint_distance(footprint, pts))
    if floor is not None:
        free = np.where(inside_polygon(pts, floor), np.minimum(free, polygon_edge_distance(pts, floor)), 0.0)
    return free


def grid_points(low: np.ndarray, high: np.ndarray, cell: float = CELL_M) -> np.ndarray:
    xs = np.arange(low[0] + cell / 2, high[0], cell)
    ys = np.arange(low[1] + cell / 2, high[1], cell)
    gx, gy = np.meshgrid(xs, ys)
    return np.column_stack([gx.ravel(), gy.ravel()])


def floor_outline(floor: Box) -> np.ndarray:
    """The floor box as a polygon, for rooms whose capture has no floor outline."""
    f = box_footprint(floor)
    v = np.array([-f.u[1], f.u[0]])
    return np.array([f.center + su * f.half[0] * f.u + sv * f.half[1] * v for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
