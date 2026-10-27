"""Where the arm stands: a spot on (or next to) the table holding the objects, from which it can
reach every object with the hand pointing down, without standing on anything."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from scan2sim.arm import ArmMount
from scan2sim.scene import Box

# Top-down grasps succeed in this band of horizontal distance from the base axis
# (measured with ik.py for targets 0-20 cm above the base within 90 degrees of its heading;
# tests/test_arm.py pins it).
REACH_MIN = 0.28
REACH_MAX = 0.76
REACH_MID = (REACH_MIN + REACH_MAX) / 2
BASE_RADIUS = 0.11  # base footprint, including its rear housing
OBJECT_CLEARANCE = 0.04  # free space between the base and any object
TABLE_EDGE_INSET = 0.12  # base centre at least this far inside the table edge
PEDESTAL_OFFSET = 0.16  # pedestal centre this far outside the table edge
FURNITURE_CLEARANCE = 0.05
GRID_STEP = 0.025
SUPPORT_TOLERANCE = 0.06


@dataclass(frozen=True)
class Footprint:
    """A thing on the table, seen from above: centre, radius and bottom height."""

    name: str
    center: np.ndarray  # world xy
    radius: float
    bottom_z: float


def footprint(name: str, points_world: np.ndarray) -> Footprint:
    points = np.asarray(points_world, dtype=np.float64)
    center = (points[:, :2].min(axis=0) + points[:, :2].max(axis=0)) / 2
    return Footprint(name, center, float(np.linalg.norm(points[:, :2] - center, axis=1).max()), float(points[:, 2].min()))


def _local_xz(box: Box, xy: np.ndarray) -> np.ndarray:
    """Point in the box's footprint coordinates (RoomPlan local x = width, z = depth)."""
    local = box.rotation.T @ (np.array([xy[0], xy[1], box.center[2]]) - box.center)
    return np.array([local[0], local[2]])


def _footprint_distance(box: Box, xy: np.ndarray) -> float:
    """Horizontal distance from xy to the box footprint (0 inside)."""
    local = np.abs(_local_xz(box, xy)) - box.half_size[[0, 2]]
    return float(np.linalg.norm(np.maximum(local, 0.0)))


def support_table(boxes: tuple[Box, ...], items: list[Footprint]) -> Box | None:
    """The colliding element most items rest on."""
    def holds(box: Box, item: Footprint) -> bool:
        return _footprint_distance(box, item.center) == 0.0 and abs(item.bottom_z - box.top_z) < SUPPORT_TOLERANCE

    counts = [(sum(holds(b, i) for i in items), b) for b in boxes if b.collides and b.kind == "object"]
    counts = [(n, b) for n, b in counts if n > 0]
    return max(counts, key=lambda c: c[0])[1] if counts else None


def _candidates(table: Box) -> list[tuple[np.ndarray, float]]:
    """(world xy, pedestal height): grid on the table top, and a ring of pedestal spots around it."""
    half = table.half_size[[0, 2]]
    spots = []
    for u in np.arange(-half[0] + TABLE_EDGE_INSET, half[0] - TABLE_EDGE_INSET + 1e-9, GRID_STEP):
        for v in np.arange(-half[1] + TABLE_EDGE_INSET, half[1] - TABLE_EDGE_INSET + 1e-9, GRID_STEP):
            spots.append((np.array([u, v]), 0.0))
    outer = half + PEDESTAL_OFFSET
    for u in np.arange(-outer[0], outer[0] + 1e-9, GRID_STEP):
        spots += [(np.array([u, -outer[1]]), table.top_z), (np.array([u, outer[1]]), table.top_z)]
    for v in np.arange(-outer[1], outer[1] + 1e-9, GRID_STEP):
        spots += [(np.array([-outer[0], v]), table.top_z), (np.array([outer[0], v]), table.top_z)]
    world = []
    for (u, v), pedestal in spots:
        point = table.center + table.rotation @ np.array([u, 0.0, v])
        world.append((point[:2], pedestal))
    return world


def choose_mount(boxes: tuple[Box, ...], items: list[Footprint]) -> ArmMount | None:
    """Best base pose: reaches the most items, keeps them mid-band; None if nothing fits."""
    table = support_table(boxes, items)
    if table is None:
        return None
    others = [b for b in boxes if b.collides and b is not table]
    best, best_score = None, None
    for xy, pedestal in _candidates(table):
        if any(np.linalg.norm(xy - i.center) < BASE_RADIUS + i.radius + OBJECT_CLEARANCE for i in items):
            continue
        if pedestal > 0 and any(_footprint_distance(b, xy) < BASE_RADIUS + FURNITURE_CLEARANCE for b in others):
            continue
        reach = np.array([np.linalg.norm(i.center - xy) for i in items])
        reachable = (reach >= REACH_MIN) & (reach <= REACH_MAX)
        # Prefer standing on the table (no pedestal) when it is just as good.
        score = (int(reachable.sum()), -float(np.abs(reach - REACH_MID).max()), pedestal == 0)
        if best_score is None or score > best_score:
            heading = np.mean([i.center for i, ok in zip(items, reachable) if ok] or [i.center for i in items], axis=0) - xy
            best_score = score
            best = ArmMount(
                position=np.array([xy[0], xy[1], table.top_z]),
                yaw=float(np.arctan2(heading[1], heading[0])),
                pedestal_height=pedestal,
                support=table.name,
            )
    return best


def reachable(mount: ArmMount, items: list[Footprint]) -> list[str]:
    return [i.name for i in items if REACH_MIN <= np.linalg.norm(i.center - mount.position[:2]) <= REACH_MAX]
