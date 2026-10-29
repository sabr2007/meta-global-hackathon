"""Our 7-DoF arm with a parallel gripper, generated as MJCF.

Proportions follow the published kinematics of the Franka Emika Panda (modified DH table below),
so the arm has the reach and dexterity of a well-studied research robot. The shells, gripper,
masses and controllers are our own; every shape is built here from rounded drums and boxes.

All shells are authored in world coordinates of the zero pose (arm straight up, hand pointing down,
base at the origin) and moved into their link frames when the MJCF is written.

One `ArmSpec` describes an instance: the name prefix, how far the gripper opens, and whether the
base carries its own housing (standing alone) or sits on another robot. The stationary arm uses
`STATIONARY`; the mobile manipulator (mobile.py) carries a wide-gripper copy on its lift.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass
from functools import cache

import numpy as np
import trimesh

from scan2sim import robot_look
from scan2sim.arm_shapes import drum, hull, rounded_box
from scan2sim.frames import quat_from_matrix

GROUP_ARM = 5  # visible robot shells; the viewer draws them with the robot materials
GROUP_HELPERS = GROUP_ARM + 1  # invisible finger colliders and sites
# Robot geoms collide with the world and objects (contype 1) but never with each other.
ARM_CONTYPE, ARM_CONAFFINITY = 2, 1
COLLIDER_MAX_VERTICES = 48

Z = np.array([0.0, 0.0, 1.0])
Y = np.array([0.0, 1.0, 0.0])


@dataclass(frozen=True)
class Joint:
    a: float  # modified DH: link length a_{i-1}
    d: float  # link offset d_i
    alpha: float  # link twist alpha_{i-1}
    lower: float
    upper: float
    kp: float  # position gain, N m / rad
    torque: float  # actuator limit, N m


JOINTS = (
    Joint(0.0, 0.333, 0.0, -2.90, 2.90, 900.0, 87.0),
    Joint(0.0, 0.0, -np.pi / 2, -1.76, 1.76, 900.0, 87.0),
    Joint(0.0, 0.316, np.pi / 2, -2.90, 2.90, 700.0, 87.0),
    Joint(0.0825, 0.0, np.pi / 2, -3.07, -0.07, 700.0, 87.0),
    Joint(-0.0825, 0.384, -np.pi / 2, -2.90, 2.90, 250.0, 12.0),
    Joint(0.0, 0.0, np.pi / 2, -0.02, 3.75, 250.0, 12.0),
    Joint(0.088, 0.0, np.pi / 2, -2.90, 2.90, 120.0, 12.0),
)
FLANGE_OFFSET = 0.107  # along link 7's z
LINK_MASSES = (3.6, 3.4, 2.6, 2.6, 3.0, 1.5, 0.5)  # links 1-7, kg
BASE_MASS = 2.0  # only used when the base moves (carried by another robot)
HAND_MASS = 0.7
FINGER_MASS = 0.08
JOINT_ARMATURE = 0.1
JOINT_DAMPING = 2.0

# Gripper (hand frame: origin at the flange, +z points out of the hand, fingers slide along y).
PALM_BOTTOM = 0.092
FINGER_LENGTH = 0.062
FINGER_HALF = np.array([0.012, 0.0085, FINGER_LENGTH / 2])  # x, y (thickness), z
FINGER_TRAVEL = 0.055  # per finger: the stationary arm's gripper opens to 11 cm
PALM_SIDE_MARGIN = 0.04  # the palm reaches this far past a fully open finger's inner face
PAD_HALF_HEIGHT = 0.012
GRIP_POINT = PALM_BOTTOM + FINGER_LENGTH - PAD_HALF_HEIGHT  # TCP: centre of the pads, near the tips
TIP_BELOW_GRIP = PALM_BOTTOM + FINGER_LENGTH - GRIP_POINT
GRIPPER_KP = 800.0
GRIPPER_FORCE = 20.0
# Sliding, torsional and rolling friction: rubber pads keep rounded objects from rolling between them.
FINGER_FRICTION = "1.6 0.05 0.03"
# Stiffer than MuJoCo's default contact: light fingers squeezing light objects sink in otherwise.
FINGER_SOLREF = "0.006 1"
FINGER_SOLIMP = "0.95 0.99 0.001"

HOME = (0.0, -0.785, 0.0, -2.356, 0.0, 1.571, 0.785)  # compact "ready" pose, hand down
# Folded with the hand straight down, 3 cm in front of the base axis and 45 cm above the base:
# the mobile manipulator drives like this, holding objects inside its footprint.
STOW = (0.0, -1.6, 0.0, -2.53, 0.0, 0.93, 0.785)


@dataclass(frozen=True)
class ArmSpec:
    """One arm instance: MJCF name prefix, gripper opening and base style."""

    prefix: str = "arm"
    finger_travel: float = FINGER_TRAVEL  # per finger; the gripper opens to twice this
    housing: bool = True  # rear housing on the base (the arm stands alone)

    @property
    def joint_names(self) -> tuple[str, ...]:
        return tuple(f"{self.prefix}_joint{i}" for i in range(1, 8))

    @property
    def link_names(self) -> tuple[str, ...]:
        return (f"{self.prefix}_base", *(f"{self.prefix}_link{i}" for i in range(1, 8)), f"{self.prefix}_hand")

    @property
    def finger_joints(self) -> tuple[str, str]:
        return (f"{self.prefix}_finger_left", f"{self.prefix}_finger_right")

    @property
    def gripper_actuator(self) -> str:
        return f"{self.prefix}_gripper"

    @property
    def grip_site(self) -> str:
        return f"{self.prefix}_grip"

    @property
    def flange_site(self) -> str:
        return f"{self.prefix}_flange"

    @property
    def status_light(self) -> str:
        return f"{self.prefix}_status_light"

    @property
    def gripper_open(self) -> float:
        return self.finger_travel

    @property
    def max_width(self) -> float:
        return 2 * self.finger_travel

    @property
    def palm_half_width(self) -> float:
        return self.finger_travel + PALM_SIDE_MARGIN

    def home_ctrl(self, pose: tuple[float, ...] = HOME) -> np.ndarray:
        return np.array([*pose, self.gripper_open])


STATIONARY = ArmSpec()

# Names of the stationary arm (the scene's `arm`), kept as module constants for older callers.
PREFIX = STATIONARY.prefix
JOINT_NAMES = STATIONARY.joint_names
LINK_NAMES = STATIONARY.link_names
FINGER_JOINTS = STATIONARY.finger_joints
GRIPPER_ACTUATOR = STATIONARY.gripper_actuator
GRIP_SITE = STATIONARY.grip_site
FLANGE_SITE = STATIONARY.flange_site
GRIPPER_OPEN = STATIONARY.gripper_open


@dataclass(frozen=True)
class ArmMount:
    """Where the arm stands: base origin in the world (on its support surface) and heading."""

    position: np.ndarray
    yaw: float
    pedestal_height: float = 0.0  # > 0 when the arm stands on a column next to the table
    support: str | None = None  # name of the element it stands on
    mocap: bool = True  # the base is a mocap body: the app moves the arm without recompiling


@dataclass(frozen=True)
class Part:
    body: str
    name: str
    mesh: trimesh.Trimesh  # world coordinates of the zero pose, or hand-local for the hand/fingers
    material: str  # robot_look material name
    collides: bool


def _rot_x(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def joint_offset(joint: Joint) -> tuple[np.ndarray, np.ndarray]:
    """Child body frame in its parent's frame at q = 0: position and rotation (modified DH)."""
    return np.array([joint.a, -np.sin(joint.alpha) * joint.d, np.cos(joint.alpha) * joint.d]), _rot_x(joint.alpha)


def zero_pose_frames() -> list[tuple[np.ndarray, np.ndarray]]:
    """World pose (position, rotation) of links 1-7 at q = 0 with the base at the origin."""
    frames = []
    position, rotation = np.zeros(3), np.eye(3)
    for joint in JOINTS:
        offset, turn = joint_offset(joint)
        position, rotation = position + rotation @ offset, rotation @ turn
        frames.append((position, rotation))
    return frames


SHELL, PANEL, SEAL, METAL = "robot_shell", "robot_panel", "robot_seal", "robot_metal"


def _link_parts(spec: ArmSpec) -> list[Part]:
    """Shells of the base and links 1-7 in zero-pose world coordinates."""
    j2, j4, j6 = np.array([0, 0, 0.333]), np.array([0.0825, 0, 0.649]), np.array([0, 0, 1.033])
    wrist = np.array([0.088, 0.0, 0.0])
    up = np.zeros(3)

    def seal(body, center, axis, radius, start, end):
        return Part(body, f"{body}_seal", hull(drum(center, axis, radius, start, end)), SEAL, False)

    def shell(body, *clouds):
        return Part(body, f"{body}_shell", hull(*clouds), SHELL, True)

    base, l1, l2, l3, l4, l5, l6, l7 = spec.link_names[:8]
    base_drum = drum(up, Z, 0.082, 0.0, 0.13, 0.006, 0.008)
    housing = rounded_box([-0.095, 0, 0.05], [0.075, 0.07, 0.05], 0.022)
    return [
        shell(base, base_drum, housing) if spec.housing else shell(base, base_drum),
        Part(base, f"{base}_foot", hull(drum(up, Z, 0.09, 0.0, 0.012, 0.0, 0.003)), SEAL, False),
        # Lime while the robot is fine; the app may tint it orange when the robot reports a problem.
        Part(base, spec.status_light, hull(drum(up, Z, 0.0835, 0.094, 0.104)), robot_look.STATUS_OK, False),
        seal(l1, up, Z, 0.074, 0.128, 0.140),
        shell(l1, drum(up, Z, 0.078, 0.138, 0.24, 0.006, 0.0), drum(j2, Y, 0.072, -0.078, -0.005, 0.014, 0.004)),
        seal(l2, j2, Y, 0.067, -0.006, 0.006),
        shell(l2, drum(j2, Y, 0.072, 0.005, 0.078, 0.004, 0.014), drum(up, Z, 0.07, 0.47, 0.545, 0.0, 0.006)),
        seal(l3, up, Z, 0.065, 0.543, 0.555),
        shell(l3, drum(up, Z, 0.069, 0.553, 0.60, 0.006, 0.0), drum(j4, Y, 0.066, 0.005, 0.074, 0.004, 0.014)),
        seal(l4, j4, Y, 0.061, -0.006, 0.006),
        shell(l4, drum(j4, Y, 0.066, -0.074, -0.005, 0.014, 0.004), drum(up, Z, 0.062, 0.72, 0.772, 0.0, 0.006)),
        seal(l5, up, Z, 0.057, 0.770, 0.781),
        shell(
            l5,
            drum(up, Z, 0.061, 0.779, 0.86, 0.006, 0.0),
            drum([0.012, 0, 0], Z, 0.05, 0.93, 0.95),
            drum(j6, Y, 0.056, -0.062, -0.005, 0.014, 0.004),
        ),
        seal(l6, j6, Y, 0.052, -0.006, 0.006),
        shell(l6, drum(j6, Y, 0.056, 0.005, 0.062, 0.004, 0.014), drum(wrist, Z, 0.052, 0.986, 1.07, 0.0, 0.014)),
        seal(l7, wrist, Z, 0.047, 0.976, 0.988),
        Part(l7, f"{l7}_shell", hull(drum(wrist, Z, 0.051, 0.937, 0.978, 0.004, 0.006)), SHELL, True),
        Part(l7, f"{l7}_flange", hull(drum(wrist, Z, 0.046, 0.926, 0.938, 0.002, 0.0)), METAL, False),
    ]


def _hand_parts(spec: ArmSpec) -> list[Part]:
    """Hand-local shells (origin at the flange, +z out of the hand)."""
    hand = spec.link_names[8]
    palm_top = 0.012
    palm_half = np.array([0.03, spec.palm_half_width, (PALM_BOTTOM - palm_top - 0.016) / 2])
    palm_center = [0, 0, PALM_BOTTOM - palm_half[2]]
    return [
        Part(hand, f"{hand}_coupling", hull(drum(np.zeros(3), Z, 0.042, 0.0, palm_top + 0.004, 0.0, 0.002)), SEAL, False),
        Part(
            hand,
            f"{hand}_shell",
            hull(drum(np.zeros(3), Z, 0.045, palm_top, palm_top + 0.012, 0.004, 0.0), rounded_box(palm_center, palm_half, 0.014)),
            PANEL,
            True,
        ),
    ]


def _finger_parts(spec: ArmSpec, side: str, sign: float) -> list[Part]:
    """Finger-local shells at q = 0, where the inner faces meet at y = 0."""
    body = f"{spec.prefix}_finger_{side}"
    center = np.array([0.0, sign * FINGER_HALF[1], PALM_BOTTOM + FINGER_HALF[2]])
    pad_half = np.array([FINGER_HALF[0] - 0.001, 0.0015, PAD_HALF_HEIGHT - 0.001])
    pad_center = np.array([0.0, sign * pad_half[1], GRIP_POINT])
    slider = np.array([0.0, sign * 0.016, PALM_BOTTOM + 0.004])
    return [
        Part(
            body,
            f"{body}_shell",
            hull(rounded_box(center + [0, sign * 0.0015, 0], FINGER_HALF - [0, 0.0015, 0], 0.004), rounded_box(slider, [0.014, 0.016, 0.006], 0.004)),
            METAL,
            False,
        ),
        Part(body, f"{body}_pad", hull(rounded_box(pad_center, pad_half, 0.0012)), SEAL, False),
    ]


@cache
def arm_parts(spec: ArmSpec = STATIONARY) -> tuple[Part, ...]:
    return (*_link_parts(spec), *_hand_parts(spec), *_finger_parts(spec, "left", 1.0), *_finger_parts(spec, "right", -1.0))


def fmt(values) -> str:
    return " ".join(f"{float(v):.6g}" for v in np.ravel(values))


def _local_mesh(part: Part, frames: dict[str, tuple[np.ndarray, np.ndarray]]) -> trimesh.Trimesh:
    if part.body not in frames:
        return part.mesh  # authored in its own frame (hand, fingers)
    position, rotation = frames[part.body]
    return trimesh.Trimesh((part.mesh.vertices - position) @ rotation, part.mesh.faces, process=False)


def inertial(body: ET.Element, meshes: list[trimesh.Trimesh], mass: float) -> None:
    """Inertia of the body's convex envelope with the given mass (shells are not solid)."""
    envelope = trimesh.convex.convex_hull(np.vstack([m.vertices for m in meshes]))
    inertia = envelope.moment_inertia * (mass / envelope.volume)
    ET.SubElement(
        body,
        "inertial",
        pos=fmt(envelope.center_mass),
        mass=fmt([mass]),
        fullinertia=fmt([inertia[0, 0], inertia[1, 1], inertia[2, 2], inertia[0, 1], inertia[0, 2], inertia[1, 2]]),
    )


def part_geoms(asset: ET.Element, body: ET.Element, parts: list[Part], meshes: list[trimesh.Trimesh]) -> None:
    """Mesh assets and geoms for robot parts: drawn in the robot group, colliders where marked."""
    for part, mesh in zip(parts, meshes):
        attrs = {"name": part.name, "vertex": fmt(mesh.vertices), "face": fmt(mesh.faces)}
        if part.collides:
            attrs["maxhullvert"] = str(COLLIDER_MAX_VERTICES)
        ET.SubElement(asset, "mesh", attrs)
        ET.SubElement(
            body,
            "geom",
            name=part.name,
            type="mesh",
            mesh=part.name,
            material=part.material,
            group=str(GROUP_ARM),
            contype=str(ARM_CONTYPE if part.collides else 0),
            conaffinity=str(ARM_CONAFFINITY if part.collides else 0),
        )


def _finger(asset: ET.Element, hand: ET.Element, spec: ArmSpec, side: str, sign: float, parts: list[Part]) -> None:
    body = ET.SubElement(hand, "body", name=f"{spec.prefix}_finger_{side}", gravcomp="1")
    meshes = [p.mesh for p in parts]
    inertial(body, meshes, FINGER_MASS)
    ET.SubElement(
        body,
        "joint",
        name=f"{spec.prefix}_finger_{side}",
        type="slide",
        axis=fmt([0, sign, 0]),
        range=fmt([0.0, spec.finger_travel]),
        armature="0.01",
        damping="5",
    )
    part_geoms(asset, body, parts, meshes)
    # Contact through a plain box: steadier grasps than a mesh.
    ET.SubElement(
        body,
        "geom",
        name=f"{spec.prefix}_finger_{side}_pad_collider",
        type="box",
        pos=fmt([0, sign * FINGER_HALF[1], PALM_BOTTOM + FINGER_HALF[2]]),
        size=fmt(FINGER_HALF),
        friction=FINGER_FRICTION,
        solref=FINGER_SOLREF,
        solimp=FINGER_SOLIMP,
        condim="6",
        group=str(GROUP_HELPERS),
        contype=str(ARM_CONTYPE),
        conaffinity=str(ARM_CONAFFINITY),
        rgba="1 1 1 0",
    )


def yaw_quat(yaw: float) -> np.ndarray:
    return np.array([np.cos(yaw / 2), 0.0, 0.0, np.sin(yaw / 2)])


def add_arm(
    root: ET.Element, asset: ET.Element, parent: ET.Element, mount: ArmMount, spec: ArmSpec = STATIONARY
) -> ET.Element:
    """Append an arm (materials, meshes, bodies, actuators) to an MJCF document; returns its base body.

    `parent` is the worldbody for a standalone arm (its base is a mocap body when `mount.mocap`),
    or a body of the robot that carries it (`mount` is then relative to that body)."""
    robot_look.add_materials(asset)
    names = spec.link_names
    frames = dict(zip(names[1:8], zero_pose_frames()))
    frames[names[0]] = (np.zeros(3), np.eye(3))
    by_body: dict[str, list[Part]] = {}
    for part in arm_parts(spec):
        by_body.setdefault(part.body, []).append(part)

    base_attrs = {"name": names[0], "pos": fmt(mount.position), "quat": fmt(yaw_quat(mount.yaw))}
    if mount.mocap:
        base_attrs["mocap"] = "true"
    else:
        base_attrs["gravcomp"] = "1"  # carried by another robot: it moves, so it needs a real mass
    base = ET.SubElement(parent, "body", base_attrs)
    base_meshes = [_local_mesh(p, frames) for p in by_body[names[0]]]
    if not mount.mocap:
        inertial(base, base_meshes, BASE_MASS)
    part_geoms(asset, base, by_body[names[0]], base_meshes)
    if mount.pedestal_height > 0:
        ET.SubElement(
            base,
            "geom",
            name=f"{spec.prefix}_pedestal",
            type="box",
            pos=fmt([-0.03, 0, -mount.pedestal_height / 2]),
            size=fmt([0.13, 0.11, mount.pedestal_height / 2]),
            material=SEAL,
            group=str(GROUP_ARM),
        )

    chain = base
    for i, joint in enumerate(JOINTS):
        name = names[i + 1]
        offset, turn = joint_offset(joint)
        body = ET.SubElement(chain, "body", name=name, pos=fmt(offset), quat=fmt(quat_from_matrix(turn)), gravcomp="1")
        meshes = [_local_mesh(p, frames) for p in by_body[name]]
        inertial(body, meshes, LINK_MASSES[i])
        ET.SubElement(
            body,
            "joint",
            name=spec.joint_names[i],
            axis="0 0 1",
            range=fmt([joint.lower, joint.upper]),
            armature=fmt([JOINT_ARMATURE]),
            damping=fmt([JOINT_DAMPING]),
        )
        part_geoms(asset, body, by_body[name], meshes)
        chain = body
    ET.SubElement(chain, "site", name=spec.flange_site, pos=fmt([0, 0, FLANGE_OFFSET]), size="0.005", group=str(GROUP_HELPERS))

    hand = ET.SubElement(chain, "body", name=names[8], pos=fmt([0, 0, FLANGE_OFFSET]), gravcomp="1")
    hand_parts = by_body[names[8]]
    inertial(hand, [p.mesh for p in hand_parts], HAND_MASS)
    part_geoms(asset, hand, hand_parts, [p.mesh for p in hand_parts])
    ET.SubElement(hand, "site", name=spec.grip_site, pos=fmt([0, 0, GRIP_POINT]), size="0.006", group=str(GROUP_HELPERS))
    _finger(asset, hand, spec, "left", 1.0, by_body[spec.finger_joints[0]])
    _finger(asset, hand, spec, "right", -1.0, by_body[spec.finger_joints[1]])

    tendon = ET.SubElement(root, "tendon")
    grip = ET.SubElement(tendon, "fixed", name=spec.gripper_actuator)
    for finger in spec.finger_joints:
        ET.SubElement(grip, "joint", joint=finger, coef="0.5")
    equality = ET.SubElement(root, "equality")
    ET.SubElement(equality, "joint", joint1=spec.finger_joints[0], joint2=spec.finger_joints[1], solref="0.005 1")

    actuator = ET.SubElement(root, "actuator")
    for name, joint in zip(spec.joint_names, JOINTS):
        ET.SubElement(
            actuator,
            "position",
            name=name,
            joint=name,
            kp=fmt([joint.kp]),
            dampratio="1",
            ctrlrange=fmt([joint.lower, joint.upper]),
            forcerange=fmt([-joint.torque, joint.torque]),
        )
    ET.SubElement(
        actuator,
        "position",
        name=spec.gripper_actuator,
        tendon=spec.gripper_actuator,
        kp=fmt([GRIPPER_KP]),
        dampratio="1",
        ctrlrange=fmt([0.0, spec.finger_travel]),
        forcerange=fmt([-GRIPPER_FORCE, GRIPPER_FORCE]),
    )
    return base


def home_ctrl() -> np.ndarray:
    return STATIONARY.home_ctrl()


def rest_state(spec: ArmSpec = STATIONARY, pose: tuple[float, ...] = HOME) -> tuple[dict[str, float], dict[str, float]]:
    """Joint positions and actuator targets of an arm resting in `pose` with the gripper open."""
    qpos = {**dict(zip(spec.joint_names, pose)), **{f: spec.gripper_open for f in spec.finger_joints}}
    ctrl = dict(zip((*spec.joint_names, spec.gripper_actuator), spec.home_ctrl(pose)))
    return qpos, ctrl
