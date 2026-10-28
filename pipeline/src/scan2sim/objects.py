"""Scanned objects: a verified mask + its LiDAR points + its SAM 3D mesh -> a dynamic body."""

from __future__ import annotations

import io
import re

import numpy as np
import trimesh

from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.images import UprightImage
from scan2sim.object_mesh import convex_hull, mean_color, oriented_size, simplify
from scan2sim.placement import place_mesh
from scan2sim.reconstruct import ObjectReconstruction
from scan2sim.scene import Box, ScannedObject

DROP_GAP_M = 0.003  # start just above the support so the drop is gentle
SUPPORT_TOLERANCE_M = 0.05  # RoomPlan tops can sit a few cm above the real surface
FOOTPRINT_MARGIN_M = 0.03
# An object rests on the scanned surface when its lowest LiDAR points start this close to the
# RoomPlan top: below covers tops placed above the real surface, above covers small stacks
# (a case on a notebook), while a wall shelf over the table sits ~0.4 m higher.
ON_SURFACE_BELOW_M = 0.06
ON_SURFACE_ABOVE_M = 0.10


def body_name(index: int, label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "object"
    return f"obj_{index}_{slug}"


def _over_footprint(box: Box, xy: np.ndarray) -> bool:
    local = box.rotation.T @ (np.array([xy[0], xy[1], box.center[2]]) - box.center)
    # RoomPlan local axes are x width, y height, z depth, so the footprint is local x/z.
    return abs(local[0]) <= box.half_size[0] + FOOTPRINT_MARGIN_M and abs(local[2]) <= box.half_size[2] + FOOTPRINT_MARGIN_M


def support_top(boxes: tuple[Box, ...], xy: np.ndarray, bottom_z: float) -> float:
    """Top of the highest colliding element under xy that an object at bottom_z rests on (floor = 0)."""
    best = 0.0
    for box in boxes:
        if not box.collides or box.top_z > bottom_z + SUPPORT_TOLERANCE_M:
            continue
        if _over_footprint(box, xy):
            best = max(best, box.top_z)
    return best


def target_surface(boxes: tuple[Box, ...], element_name: str | None = None) -> Box | None:
    """The RoomPlan element whose objects are scanned: the named one, else the largest table."""
    candidates = [b for b in boxes if (b.name == element_name if element_name else b.category == "table")]
    return max(candidates, key=lambda b: b.half_size[0] * b.half_size[2], default=None)


def rests_on(surface: Box, center_xy: np.ndarray, bottom_z: float) -> bool:
    """Whether an object centred at center_xy, whose LiDAR points start at bottom_z, lies on `surface`."""
    if not surface.top_z - ON_SURFACE_BELOW_M <= bottom_z <= surface.top_z + ON_SURFACE_ABOVE_M:
        return False
    return _over_footprint(surface, center_xy)


def build_scanned_object(
    name: str,
    label: str,
    reconstruction: ObjectReconstruction,
    lidar_points_world: np.ndarray,
    image: UprightImage,
    view: CameraView,
    frame: WorldFrame,
    boxes: tuple[Box, ...],
) -> ScannedObject:
    mesh = trimesh.load(io.BytesIO(reconstruction.glb), file_type="glb", force="mesh")
    placement = place_mesh(mesh.vertices, reconstruction.pose, image, view, frame, lidar_points_world)
    world = placement.vertices_world
    low, high = world.min(axis=0), world.max(axis=0)
    # Lift objects out of the RoomPlan collider they rest on; never push them down.
    support = support_top(boxes, (low[:2] + high[:2]) / 2, low[2])
    world = world + np.array([0.0, 0.0, max(0.0, support + DROP_GAP_M - low[2])])
    low, high = world.min(axis=0), world.max(axis=0)
    origin = (low + high) / 2
    local = trimesh.Trimesh(world - origin, mesh.faces, vertex_colors=mesh.visual.vertex_colors, process=False)
    visual = simplify(local)
    hull_vertices, hull_faces = convex_hull(visual.vertices)
    return ScannedObject(
        name=name,
        label=label,
        position=origin,
        visual_glb=visual.export(file_type="glb"),
        hull_vertices=hull_vertices,
        hull_faces=hull_faces,
        size=oriented_size(visual.vertices),
        rgba=mean_color(visual),
        depth_scale=placement.depth_scale,
        fit_error_m=placement.fit_error_m,
    )
