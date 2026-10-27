"""Pick capture photos that look at a given point (camera poses from ARKit)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from scan2sim.capture import CameraView


@dataclass(frozen=True)
class ViewHit:
    view: CameraView
    pixel: tuple[float, float]  # sensor pixel where the point lands
    distance_m: float
    centrality: float  # 0 = image centre, ~0.7 = corner


def project(view: CameraView, point_arkit: np.ndarray) -> tuple[np.ndarray, float] | None:
    """Sensor pixel of an ARKit point, or None if it is behind the camera. ARKit cameras look down -Z."""
    world_to_camera = np.linalg.inv(view.camera_to_world)
    p = world_to_camera @ np.append(point_arkit, 1.0)
    depth = -p[2]
    if depth <= 0.0:
        return None
    k = view.intrinsics
    x = k[0, 0] * p[0] / depth + k[0, 2]
    y = k[1, 1] * -p[1] / depth + k[1, 2]  # image y grows downwards, camera y up
    return np.array([x, y]), float(depth)


DISTANCE_PENALTY_PER_M = 0.12  # trade-off between a centred view and a close one
COMFORT_DISTANCE_M = 0.8  # closer than this does not earn extra credit


def view_score(hit: ViewHit) -> float:
    """Lower is better: central in frame and close enough for small objects."""
    return hit.centrality + DISTANCE_PENALTY_PER_M * max(hit.distance_m - COMFORT_DISTANCE_M, 0.0)


def views_of(point_arkit: np.ndarray, views: tuple[CameraView, ...]) -> list[ViewHit]:
    """Views in which the point is visible, best (central and close) first."""
    hits = []
    for view in views:
        projected = project(view, point_arkit)
        if projected is None:
            continue
        (x, y), depth = projected
        if 0 <= x < view.width and 0 <= y < view.height:
            centrality = float(np.hypot(x / view.width - 0.5, y / view.height - 0.5))
            hits.append(ViewHit(view=view, pixel=(float(x), float(y)), distance_m=depth, centrality=centrality))
    return sorted(hits, key=view_score)
