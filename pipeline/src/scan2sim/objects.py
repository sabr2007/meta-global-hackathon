"""Scanned objects: a verified mask + its LiDAR points + its SAM 3D mesh -> a dynamic body."""

from __future__ import annotations

import dataclasses

import io
import re

import numpy as np
import trimesh

from scan2sim.bake import bake_photo_colors
from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.hero import full_raster, upright_camera
from scan2sim.images import UprightImage
from scan2sim.object_mesh import collider_pieces, convex_hull, mean_color, oriented_size, simplify
from scan2sim.placement import place_mesh
from scan2sim.reconstruct import ObjectReconstruction
from scan2sim.scene import Box, ScannedObject
from scan2sim.segmentation import ObjectMask

DROP_GAP_M = 0.003  # start just above the support so the drop is gentle
SUPPORT_TOLERANCE_M = 0.05  # RoomPlan tops can sit a few cm above the real surface
FOOTPRINT_MARGIN_M = 0.03
# An object rests on the scanned surface when its lowest LiDAR points start this close to the
# RoomPlan top: below covers tops placed above the real surface, above covers small stacks
# (a case on a notebook), while a wall shelf over the table sits ~0.4 m higher.
ON_SURFACE_BELOW_M = 0.06
MAX_TOP_FIT_M = 0.05
STAND_MIN_M = 0.008  # an object this far above its surface rests on something unscanned (a tray, a stand)
UPRIGHT = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])  # box local y (RoomPlan height) -> world z  # never move a RoomPlan top further than this to meet the LiDAR surface
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


def fit_top(box: Box, top_z: float) -> Box:
    """The box with its top moved down to `top_z` (RoomPlan tops sit 1-2 cm above the LiDAR surface)."""
    drop = box.top_z - top_z
    if drop <= 0 or drop > MAX_TOP_FIT_M:
        return box
    vertical = int(np.argmax(np.abs(box.rotation[2])))  # local axis that points up in the world
    half = box.half_size.copy()
    half[vertical] -= drop / 2
    return dataclasses.replace(box, center=box.center - np.array([0.0, 0.0, drop / 2]), half_size=half)


def stand_under(obj: ScannedObject, surface: Box) -> Box | None:
    """A static block that fills the gap between an object and its surface (e.g. a laptop on a tray),
    so lowering the surface to the LiDAR height does not drop the object."""
    world = obj.hull_vertices + obj.position
    gap = float(world[:, 2].min()) - DROP_GAP_M - surface.top_z
    if gap < STAND_MIN_M:
        return None
    low, high = world[:, :2].min(axis=0), world[:, :2].max(axis=0)
    center = np.array([*(low + high) / 2, surface.top_z + gap / 2])
    half = np.array([(high[0] - low[0]) / 2, gap / 2, (high[1] - low[1]) / 2])
    return Box(f"{obj.name}_stand", "object", "table", center, UPRIGHT, half, True, "low", "")


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
    mask: ObjectMask | None = None,
    surface: Box | None = None,
) -> ScannedObject:
    """`mask` is the object's SAM 3.1 mask in `image` (the mesh is matched to it in the photo and
    takes the photo's colours inside it); `surface` is the table it stands on (a mesh the LiDAR puts
    inside it is slid back onto it)."""
    raw = trimesh.load(io.BytesIO(reconstruction.glb), file_type="glb", force="mesh")
    light = simplify(raw)  # decimate first: placement renders and measures the mesh several times
    rest_z = surface.top_z + DROP_GAP_M if surface is not None else None
    placement = place_mesh(
        light.vertices, light.faces, reconstruction.pose, image, view, frame, lidar_points_world, mask, rest_z
    )
    world = placement.vertices_world
    colors = light.visual.vertex_colors
    if mask is not None:  # where the photo sees the mesh, before any lift moves it off its pixels
        camera = upright_camera(view, image, frame)
        placed = trimesh.Trimesh(world, light.faces, vertex_colors=colors, process=False)
        colors = bake_photo_colors(placed, camera, np.asarray(image.image), full_raster(mask, (camera.width, camera.height)))
    low, high = world.min(axis=0), world.max(axis=0)
    # Lift objects out of the RoomPlan collider they rest on; never push them down.
    support = support_top(boxes, (low[:2] + high[:2]) / 2, low[2])
    world = world + np.array([0.0, 0.0, max(0.0, support + DROP_GAP_M - low[2])])
    low, high = world.min(axis=0), world.max(axis=0)
    origin = (low + high) / 2
    visual = trimesh.Trimesh(world - origin, light.faces, vertex_colors=colors, process=False)
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
        level_deg=placement.level_deg,
        photo_scale=placement.photo_scale,
        depth_source=placement.depth_source,
        collider_pieces=tuple(collider_pieces(visual.vertices, visual.faces)),
    )
