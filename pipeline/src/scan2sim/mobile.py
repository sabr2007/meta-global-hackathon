"""Our mobile manipulator: a round holonomic base, a lift, and our 7-DoF arm with a wide gripper.

The base moves on three actuated planar joints (x, y, yaw) whose values are world coordinates,
so the web controller drives it by setting position targets along a planned path. The arm sits
on a carriage that slides up a column, so it can work at any table height from 0.40 to 1.00 m.
Its gripper opens to 16 cm (the stationary arm's to 11 cm).

Collisions: the base, column and carriage are drawn but do not collide (navigation keeps them
away from walls and furniture, and RoomPlan boxes are only bounding boxes); the arm collides
with walls, tables and objects exactly like the stationary arm.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass

import numpy as np

from scan2sim import arm, navgrid, robot_look
from scan2sim.arm import ArmMount, ArmSpec, fmt, inertial, part_geoms, Part
from scan2sim.arm_shapes import drum, hull, rounded_box
from scan2sim.scene import Box

PREFIX = "mobile"
ARM = ArmSpec(prefix=f"{PREFIX}_arm", finger_travel=0.08, housing=False)  # opens to 16 cm

CHASSIS_RADIUS = 0.24
FOOTPRINT_RADIUS = 0.25  # bumper included: the disc navigation keeps clear of obstacles
NAV_MARGIN = 0.03  # extra clearance the planner keeps around the footprint
DECK_Z = 0.25  # top of the chassis
ARM_OFFSET = 0.14  # the arm's axis stands this far in front of the base centre
LIFT_BASE_Z = 0.40  # arm base height at the bottom of the lift
LIFT_TRAVEL = 0.60  # so the arm base reaches 1.00 m
LIFT_HOME = 0.0
COLUMN_TOP_Z = LIFT_BASE_Z + LIFT_TRAVEL + 0.06

BASE_MASS = 40.0
CARRIAGE_MASS = 3.0
# Position servos on the planar joints and the lift (critically damped).
DRIVE_KP = 60000.0  # N/m
DRIVE_FORCE = 2000.0
YAW_KP = 6000.0  # N m / rad
YAW_TORQUE = 800.0
LIFT_KP = 30000.0
LIFT_FORCE = 1500.0

# Driving limits used by the web controller (scene.json carries them).
MAX_SPEED = 0.4  # m/s
MAX_ACCEL = 0.5  # m/s^2
MAX_TURN_RATE = 1.2  # rad/s

START_EXTRA_CLEARANCE = 0.12  # start on open floor, not squeezed between furniture
START_MAX_DISTANCE = 2.0  # from the table edge

BASE_JOINTS = (f"{PREFIX}_x", f"{PREFIX}_y", f"{PREFIX}_yaw")
LIFT_JOINT = f"{PREFIX}_lift"
BASE_BODY = f"{PREFIX}_base"
LIFT_BODY = f"{PREFIX}_carriage"
STATUS_LIGHT = f"{PREFIX}_status_light"

SHELL, PANEL, SEAL, METAL = arm.SHELL, arm.PANEL, arm.SEAL, arm.METAL
Z = np.array([0.0, 0.0, 1.0])
Y = np.array([0.0, 1.0, 0.0])


@dataclass(frozen=True)
class MobileMount:
    """Where the mobile manipulator starts: a free spot on the floor, facing the table."""

    position: np.ndarray  # world xy (z = 0)
    yaw: float
    near: str | None = None  # the element it starts next to


def _chassis_parts() -> list[Part]:
    """Base-local shells: drum chassis, bumper, deck, wheels, column, status light."""
    up = np.zeros(3)
    wheel_axis = Y
    parts = [
        Part(BASE_BODY, f"{PREFIX}_chassis", hull(drum(up, Z, CHASSIS_RADIUS, 0.055, DECK_Z - 0.012, 0.012, 0.03)), SHELL, False),
        Part(BASE_BODY, f"{PREFIX}_bumper", hull(drum(up, Z, FOOTPRINT_RADIUS, 0.065, 0.125, 0.012, 0.012)), SEAL, False),
        Part(BASE_BODY, f"{PREFIX}_deck", hull(drum(up, Z, CHASSIS_RADIUS - 0.03, DECK_Z - 0.014, DECK_Z, 0.0, 0.004)), PANEL, False),
        Part(BASE_BODY, STATUS_LIGHT, hull(drum(up, Z, CHASSIS_RADIUS + 0.0015, 0.17, 0.18)), robot_look.STATUS_OK, False),
        Part(
            BASE_BODY,
            f"{PREFIX}_column",
            hull(rounded_box([-0.02, 0.0, (DECK_Z + COLUMN_TOP_Z) / 2], [0.055, 0.06, (COLUMN_TOP_Z - DECK_Z) / 2], 0.012)),
            PANEL,
            False,
        ),
        Part(
            BASE_BODY,
            f"{PREFIX}_column_cap",
            hull(drum([-0.02, 0.0, 0.0], Z, 0.05, COLUMN_TOP_Z, COLUMN_TOP_Z + 0.012, 0.0, 0.004)),
            SEAL,
            False,
        ),
    ]
    for i, (sx, sy) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
        center = np.array([sx * 0.13, sy * 0.155, 0.05])
        parts.append(Part(BASE_BODY, f"{PREFIX}_wheel_{i}", hull(drum(center, wheel_axis, 0.05, -0.022, 0.022, 0.006, 0.006)), SEAL, False))
        parts.append(Part(BASE_BODY, f"{PREFIX}_hub_{i}", hull(drum(center, wheel_axis, 0.022, -0.024, 0.024, 0.003, 0.003)), METAL, False))
    return parts


def _carriage_parts() -> list[Part]:
    """Carriage-local shells (origin = arm base at this lift height): slider around the column, arm bracket."""
    column_x = -0.02 - ARM_OFFSET
    return [
        Part(LIFT_BODY, f"{PREFIX}_slider", hull(rounded_box([column_x, 0.0, -0.075], [0.075, 0.085, 0.07], 0.016)), SHELL, False),
        Part(LIFT_BODY, f"{PREFIX}_bracket", hull(rounded_box([-0.05, 0.0, -0.02], [0.13, 0.075, 0.02], 0.01)), SHELL, False),
        Part(LIFT_BODY, f"{PREFIX}_slider_trim", hull(rounded_box([column_x + 0.076, 0.0, -0.075], [0.002, 0.07, 0.055], 0.0015)), METAL, False),
    ]


def add_mobile(root: ET.Element, asset: ET.Element, worldbody: ET.Element, mount: MobileMount) -> None:
    """Append the mobile manipulator (base joints and actuators, lift, arm) to an MJCF document."""
    robot_look.add_materials(asset)
    x0, y0 = (float(v) for v in mount.position[:2])
    base = ET.SubElement(worldbody, "body", name=BASE_BODY, pos=fmt([x0, y0, 0.0]))
    # Joint values are world coordinates: x and y slide from the body's spot (ref), yaw turns about z.
    for name, axis, ref in ((BASE_JOINTS[0], "1 0 0", x0), (BASE_JOINTS[1], "0 1 0", y0)):
        ET.SubElement(base, "joint", name=name, type="slide", axis=axis, ref=fmt([ref]), damping="80", armature="1")
    ET.SubElement(base, "joint", name=BASE_JOINTS[2], type="hinge", axis="0 0 1", damping="30", armature="0.5")
    chassis = _chassis_parts()
    inertial(base, [p.mesh for p in chassis], BASE_MASS)
    part_geoms(asset, base, chassis, [p.mesh for p in chassis])

    carriage = ET.SubElement(base, "body", name=LIFT_BODY, pos=fmt([ARM_OFFSET, 0.0, LIFT_BASE_Z]), gravcomp="1")
    ET.SubElement(carriage, "joint", name=LIFT_JOINT, type="slide", axis="0 0 1", range=fmt([0.0, LIFT_TRAVEL]), damping="60", armature="1")
    parts = _carriage_parts()
    inertial(carriage, [p.mesh for p in parts], CARRIAGE_MASS)
    part_geoms(asset, carriage, parts, [p.mesh for p in parts])

    arm.add_arm(root, asset, carriage, ArmMount(np.zeros(3), 0.0, mocap=False), spec=ARM)

    actuator = ET.SubElement(root, "actuator")
    for name in BASE_JOINTS[:2]:
        ET.SubElement(actuator, "position", name=name, joint=name, kp=fmt([DRIVE_KP]), dampratio="1", forcerange=fmt([-DRIVE_FORCE, DRIVE_FORCE]))
    ET.SubElement(actuator, "position", name=BASE_JOINTS[2], joint=BASE_JOINTS[2], kp=fmt([YAW_KP]), dampratio="1", forcerange=fmt([-YAW_TORQUE, YAW_TORQUE]))
    ET.SubElement(
        actuator,
        "position",
        name=LIFT_JOINT,
        joint=LIFT_JOINT,
        kp=fmt([LIFT_KP]),
        dampratio="1",
        ctrlrange=fmt([0.0, LIFT_TRAVEL]),
        forcerange=fmt([-LIFT_FORCE, LIFT_FORCE]),
    )


def rest_state(mount: MobileMount) -> tuple[dict[str, float], dict[str, float]]:
    """Start state: at its spot, lift down, arm stowed, gripper open."""
    base = dict(zip(BASE_JOINTS, (float(mount.position[0]), float(mount.position[1]), float(mount.yaw))))
    arm_qpos, arm_ctrl = arm.rest_state(ARM, arm.STOW)
    return {**base, LIFT_JOINT: LIFT_HOME, **arm_qpos}, {**base, LIFT_JOINT: LIFT_HOME, **arm_ctrl}


def choose_start(boxes: tuple[Box, ...], floor: np.ndarray, table: Box | None) -> MobileMount | None:
    """A free spot on the floor near the table (open enough to turn around), facing it."""
    footprints = navgrid.obstacles(boxes)
    points = navgrid.grid_points(floor.min(axis=0), floor.max(axis=0))
    free = navgrid.clearance(points, footprints, floor)
    needed = FOOTPRINT_RADIUS + NAV_MARGIN + START_EXTRA_CLEARANCE
    open_floor = free >= needed
    if not open_floor.any():
        return None
    if table is None:
        best = int(np.argmax(free))
        return MobileMount(np.array([*points[best], 0.0]), 0.0)
    to_table = navgrid.footprint_distance(navgrid.box_footprint(table), points)
    candidates = open_floor & (to_table <= START_MAX_DISTANCE)
    if not candidates.any():
        return None
    # Closest open spot to the table; among equals (5 cm steps) the most open one.
    score = np.where(candidates, np.round(to_table / navgrid.CELL_M) - free, np.inf)
    best = int(np.argmin(score))
    heading = table.center[:2] - points[best]
    return MobileMount(np.array([*points[best], 0.0]), float(np.arctan2(heading[1], heading[0])), near=table.name)


def lift_for_arm_base(z: float) -> float:
    """Lift joint value that puts the arm base at height z (clamped to the travel)."""
    return float(np.clip(z - LIFT_BASE_Z, 0.0, LIFT_TRAVEL))
