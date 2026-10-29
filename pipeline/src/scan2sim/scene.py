"""RoomPlan elements -> simulation primitives in the world frame (+Z up, floor at z = 0)."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from scan2sim.arm import ArmMount
from scan2sim.frames import WorldFrame
from scan2sim.roomplan import Room, RoomElement

if TYPE_CHECKING:
    from scan2sim.mobile import MobileMount

WALL_THICKNESS = 0.12  # RoomPlan walls are planes; give them a body for collisions
OPENING_THICKNESS = 0.02  # windows/doors/openings are visual markers only
PROBE_DROP_HEIGHT = 0.25  # how far above a support surface probes start
PROBE_EDGE_INSET = 0.15  # keep probes away from table edges
PROBE_HALF_SIZE = 0.03
PROBE_RADIUS = 0.035
FALLBACK_DROP_HEIGHT = 1.0  # used when the room has no usable table

COLLIDING_KINDS = frozenset({"wall", "object"})


@dataclass(frozen=True)
class Box:
    """An oriented box in world coordinates. Local axes follow RoomPlan: x width, y height, z depth."""

    name: str
    kind: str
    category: str
    center: np.ndarray
    rotation: np.ndarray
    half_size: np.ndarray
    collides: bool
    confidence: str
    source_id: str
    attributes: dict[str, str] = field(default_factory=dict)

    @property
    def top_z(self) -> float:
        corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
        world = self.center + (corners * self.half_size) @ self.rotation.T
        return float(world[:, 2].max())


@dataclass(frozen=True)
class Probe:
    """A small dynamic object dropped into the scene to show that physics works."""

    name: str
    shape: str  # box | sphere
    size: tuple[float, ...]
    position: np.ndarray
    rgba: tuple[float, float, float, float]
    yaw: float = 0.0  # rotation about +Z
    label: str | None = None  # what the object is, for scanned objects


@dataclass(frozen=True)
class ScannedObject:
    """A movable object from the scan: SAM 3D mesh placed with LiDAR, simulated as its convex hull."""

    name: str
    label: str
    position: np.ndarray  # body origin in the world: centre of the mesh bounds
    visual_glb: bytes  # body-local mesh with vertex colours
    hull_vertices: np.ndarray  # body-local collider
    hull_faces: np.ndarray
    size: np.ndarray  # length, width (principal axes on the ground), height; meters
    rgba: tuple[float, float, float, float]
    depth_scale: float  # metric / SAM 3D depth used to place it
    fit_error_m: float  # mean LiDAR-to-mesh distance after placement
    concept: str = ""  # the SAM 3.1 noun phrase that finds it in a photo
    level_deg: float = 0.0  # tilt of its SAM 3D pose that placement removed
    photo_scale: float = 1.0  # size correction that matched its silhouette to the photo mask
    depth_source: str = "lidar"  # "lidar", or "table" when it was slid along its camera rays onto the table
    collider_pieces: tuple[tuple[np.ndarray, np.ndarray], ...] = ()  # body-local convex pieces; () = the hull
    mass_kg: float | None = None  # estimated by Muse Spark (scan2sim objects --physics); None = uniform density
    friction: float | None = None  # sliding friction on the table, with mass_kg
    physics_reason: str = ""  # Muse Spark's one-line reason for both


@dataclass(frozen=True)
class SimScene:
    frame: WorldFrame
    floor: Box
    boxes: tuple[Box, ...]
    probes: tuple[Probe, ...]
    room_label: str | None
    objects: tuple[ScannedObject, ...] = ()
    arm: ArmMount | None = None
    mobile: MobileMount | None = None
    floor_polygon: np.ndarray | None = None  # scanned floor outline, world xy (N, 2)


def world_frame_for(room: Room) -> WorldFrame:
    """World origin = centre of the RoomPlan floor, at floor height."""
    floors = room.of_kind("floor")
    if floors:
        return WorldFrame(origin_arkit=floors[0].pose_arkit[:3, 3].copy())
    walls = room.of_kind("wall")
    if not walls:
        raise ValueError("room has neither a floor nor walls; cannot place a world origin")
    centres = np.array([w.pose_arkit[:3, 3] for w in walls])
    bottoms = centres[:, 1] - np.array([w.dimensions[1] / 2 for w in walls])
    origin = centres.mean(axis=0)
    return WorldFrame(origin_arkit=np.array([origin[0], bottoms.min(), origin[2]]))


def _element_box(element: RoomElement, frame: WorldFrame, name: str) -> Box:
    center, rotation = frame.pose(element.pose_arkit)
    width, height, depth = element.dimensions
    if element.kind == "wall":
        depth = WALL_THICKNESS
        normal = rotation[:, 2]
        outward = 1.0 if np.dot(normal[:2], center[:2]) >= 0.0 else -1.0
        center = center + normal * outward * WALL_THICKNESS / 2
    elif element.kind in ("window", "door", "opening"):
        depth = OPENING_THICKNESS
    return Box(
        name=name,
        kind=element.kind,
        category=element.category,
        center=center,
        rotation=rotation,
        half_size=np.array([width, height, depth]) / 2,
        collides=element.kind in COLLIDING_KINDS,
        confidence=element.confidence,
        source_id=element.identifier,
        attributes=dict(element.attributes),
    )


def _named_boxes(room: Room, frame: WorldFrame) -> tuple[Box, ...]:
    counters: Counter[str] = Counter()
    boxes = []
    for element in room.elements:
        if element.kind == "floor":
            continue
        label = element.category if element.kind == "object" else element.kind
        boxes.append(_element_box(element, frame, f"{label}_{counters[label]}"))
        counters[label] += 1
    return tuple(boxes)


def _support_surface(boxes: tuple[Box, ...]) -> Box | None:
    """Largest confident table top: the natural place to drop probe objects."""
    tables = [b for b in boxes if b.category == "table" and b.confidence != "low"]
    if not tables:
        return None
    return max(tables, key=lambda b: b.half_size[0] * b.half_size[2])


def _probe_positions(support: Box | None, count: int) -> list[np.ndarray]:
    if count <= 0:
        return []
    if support is None:
        return [np.array([0.2 * i - 0.1 * (count - 1), 0.0, FALLBACK_DROP_HEIGHT]) for i in range(count)]
    usable_x = max(support.half_size[0] - PROBE_EDGE_INSET, 0.0)
    usable_z = max(support.half_size[2] - PROBE_EDGE_INSET, 0.0)
    columns = int(np.ceil(np.sqrt(count)))
    rows = int(np.ceil(count / columns))
    xs = np.linspace(-usable_x, usable_x, columns) if columns > 1 else np.zeros(1)
    zs = np.linspace(-usable_z, usable_z, rows) if rows > 1 else np.zeros(1)
    top = support.top_z + PROBE_DROP_HEIGHT
    positions = []
    for i in range(count):
        local = np.array([xs[i % columns], 0.0, zs[i // columns]])
        world = support.center + support.rotation @ local
        positions.append(np.array([world[0], world[1], top]))
    return positions


PROBE_COLORS = (
    (0.95, 0.42, 0.18, 1.0),
    (0.16, 0.55, 0.95, 1.0),
    (0.98, 0.78, 0.15, 1.0),
    (0.35, 0.78, 0.45, 1.0),
    (0.85, 0.30, 0.65, 1.0),
    (0.55, 0.45, 0.95, 1.0),
)


def _probes(support: Box | None, count: int) -> tuple[Probe, ...]:
    probes = []
    for i, position in enumerate(_probe_positions(support, count)):
        is_box = i % 2 == 0
        probes.append(
            Probe(
                name=f"probe_{i}",
                shape="box" if is_box else "sphere",
                size=(PROBE_HALF_SIZE,) * 3 if is_box else (PROBE_RADIUS,),
                position=position,
                rgba=PROBE_COLORS[i % len(PROBE_COLORS)],
            )
        )
    return tuple(probes)


def floor_polygon(element: RoomElement, frame: WorldFrame) -> np.ndarray | None:
    """The floor's outline corners (RoomPlan polygonCorners, element-local) as world xy."""
    if element.polygon is None:
        return None
    arkit = element.polygon @ element.pose_arkit[:3, :3].T + element.pose_arkit[:3, 3]
    return frame.points(arkit)[:, :2]


def build_scene(room: Room, probe_count: int = 6) -> SimScene:
    frame = world_frame_for(room)
    floors = room.of_kind("floor")
    if floors:
        floor = _element_box(floors[0], frame, "floor")
    else:
        floor = Box("floor", "floor", "floor", np.zeros(3), np.eye(3), np.array([5.0, 5.0, 0.0]), True, "low", "")
    boxes = _named_boxes(room, frame)
    return SimScene(
        frame=frame,
        floor=floor,
        boxes=boxes,
        probes=_probes(_support_surface(boxes), probe_count),
        room_label=room.section_label,
        floor_polygon=floor_polygon(floors[0], frame) if floors else None,
    )
