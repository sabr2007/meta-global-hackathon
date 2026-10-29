"""Synthetic RoomPlan documents: a 4 m x 3 m room, rotated in ARKit space, with one table."""

from __future__ import annotations

import numpy as np
import trimesh

from scan2sim.object_mesh import collider_pieces, convex_hull
from scan2sim.scene import ScannedObject, SimScene

FLOOR_Y = -1.2  # ARKit floor height (the phone starts ~1.2 m above the floor)
ROOM_CENTER = np.array([1.0, FLOOR_Y, -2.0])
ROOM_YAW = np.radians(30.0)
ROOM_W, ROOM_D, ROOM_H = 4.0, 3.0, 2.6
TABLE_W, TABLE_H, TABLE_D = 1.2, 0.75, 0.8
CUP_SIZE = np.array([0.08, 0.06, 0.10])
CUP_RGB = (230, 120, 30)  # orange
DROP_GAP = 0.003


def yaw_matrix(yaw: float) -> np.ndarray:
    c, s = np.cos(yaw), np.sin(yaw)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def column_major(rotation: np.ndarray, translation: np.ndarray) -> list[float]:
    m = np.eye(4)
    m[:3, :3] = rotation
    m[:3, 3] = translation
    return m.T.ravel().tolist()


def _element(category: str, dims, rotation, translation, confidence="high", **extra) -> dict:
    return {
        "category": {category: {}},
        "confidence": {confidence: {}},
        "dimensions": [float(v) for v in dims],
        "identifier": f"{category}-{len(str(translation))}-{float(translation[0]):.2f}",
        "transform": column_major(rotation, translation),
        **extra,
    }


def room_document() -> dict:
    room_rot = yaw_matrix(ROOM_YAW)
    # Floor: local x/y span the floor, local z is the normal -> rotate -90 deg about X.
    floor_rot = room_rot @ np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]])
    floor = _element("floor", (ROOM_W, ROOM_D, 0.0), floor_rot, ROOM_CENTER)

    walls = []
    wall_y = FLOOR_Y + ROOM_H / 2
    # (offset along room x, offset along room z, extra yaw, length)
    for dx, dz, yaw, length in (
        (0.0, -ROOM_D / 2, 0.0, ROOM_W),
        (0.0, ROOM_D / 2, np.pi, ROOM_W),
        (ROOM_W / 2, 0.0, -np.pi / 2, ROOM_D),
        (-ROOM_W / 2, 0.0, np.pi / 2, ROOM_D),
    ):
        center = ROOM_CENTER + room_rot @ np.array([dx, 0.0, dz])
        walls.append(
            _element("wall", (length, ROOM_H, 0.0), room_rot @ yaw_matrix(yaw), np.array([center[0], wall_y, center[2]]))
        )

    window_center = ROOM_CENTER + room_rot @ np.array([0.0, 0.0, -ROOM_D / 2])
    window = _element("window", (1.0, 1.2, 0.0), room_rot, np.array([window_center[0], FLOOR_Y + 1.5, window_center[2]]), "medium")

    table_center = ROOM_CENTER + room_rot @ np.array([0.5, 0.0, 0.3])
    table = _element(
        "table",
        (TABLE_W, TABLE_H, TABLE_D),
        room_rot,
        np.array([table_center[0], FLOOR_Y + TABLE_H / 2, table_center[2]]),
        attributes={"TableShapeType": "rectangular"},
    )
    return {
        "floors": [floor],
        "walls": walls,
        "doors": [],
        "windows": [window],
        "openings": [],
        "objects": [table],
        "sections": [{"label": "livingRoom", "center": ROOM_CENTER.tolist(), "story": 0}],
    }


def look_at(position, target, up=(0.0, 0.0, 1.0)) -> np.ndarray:
    """4x4 camera-to-world pose in OpenGL axes (looks down its -Z, +Y up in the image)."""
    position, target = np.asarray(position, dtype=np.float64), np.asarray(target, dtype=np.float64)
    back = position - target
    back /= np.linalg.norm(back)
    right = np.cross(up, back)
    right /= np.linalg.norm(right)
    pose = np.eye(4)
    pose[:3, :3] = np.column_stack([right, np.cross(back, right), back])
    pose[:3, 3] = position
    return pose


def cup_on_table(scene: SimScene, name: str = "obj_0_cup") -> ScannedObject:
    """A box-shaped orange 'scanned object' resting just above the table centre."""
    (table,) = [b for b in scene.boxes if b.category == "table"]
    hull = trimesh.creation.box(extents=CUP_SIZE)
    visual = trimesh.Trimesh(hull.vertices, hull.faces, vertex_colors=np.tile([*CUP_RGB, 255], (len(hull.vertices), 1)), process=False)
    return ScannedObject(
        name=name,
        label="cup",
        position=np.array([table.center[0], table.center[1], TABLE_H + CUP_SIZE[2] / 2 + DROP_GAP]),
        visual_glb=visual.export(file_type="glb"),
        hull_vertices=np.asarray(hull.vertices),
        hull_faces=np.asarray(hull.faces),
        size=CUP_SIZE,
        rgba=(0.9, 0.5, 0.2, 1.0),
        depth_scale=0.86,
        fit_error_m=0.005,
    )


def ring_mesh() -> trimesh.Trimesh:
    """A 7.4 cm ring, 2 cm thick, with a 3.4 cm hole."""
    return trimesh.creation.torus(major_radius=0.027, minor_radius=0.01)


def ring_on_table(scene: SimScene, decomposed: bool) -> ScannedObject:
    """The ring lying on the table, simulated as convex pieces around its hole or as one hull."""
    (table,) = [b for b in scene.boxes if b.category == "table"]
    ring = ring_mesh()
    hull_vertices, hull_faces = convex_hull(ring.vertices)
    return ScannedObject(
        name="obj_0_ring", label="ring", position=np.array([table.center[0], table.center[1], TABLE_H + 0.01 + DROP_GAP]),
        visual_glb=ring.export(file_type="glb"), hull_vertices=hull_vertices, hull_faces=hull_faces,
        size=np.array([0.074, 0.074, 0.02]), rgba=(0.9, 0.4, 0.1, 1.0), depth_scale=0.86, fit_error_m=0.004,
        collider_pieces=tuple(collider_pieces(ring.vertices, ring.faces)) if decomposed else (),
    )
