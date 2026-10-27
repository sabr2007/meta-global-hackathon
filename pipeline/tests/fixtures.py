"""Synthetic RoomPlan documents: a 4 m x 3 m room, rotated in ARKit space, with one table."""

from __future__ import annotations

import numpy as np

FLOOR_Y = -1.2  # ARKit floor height (the phone starts ~1.2 m above the floor)
ROOM_CENTER = np.array([1.0, FLOOR_Y, -2.0])
ROOM_YAW = np.radians(30.0)
ROOM_W, ROOM_D, ROOM_H = 4.0, 3.0, 2.6
TABLE_W, TABLE_H, TABLE_D = 1.2, 0.75, 0.8


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
