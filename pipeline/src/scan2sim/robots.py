"""Robot registry: every robot kind has an MJCF generator, a start state and a scene.json entry.

The web app reads `scene.json` -> `robots` (web/src/sim/robots.ts creates one controller per entry).
Kinds:
  arm     our stationary 7-DoF arm on the table (arm.py); its base is a mocap body, so the app can
          drag it to another spot on the table without recompiling the model
  mobile  our mobile manipulator (mobile.py): holonomic base + lift + the same arm, wider gripper
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from scan2sim import arm, mobile
from scan2sim.mount import BASE_RADIUS, REACH_MAX, REACH_MIN
from scan2sim.scene import SimScene

KEYFRAME = "home"
PEDESTAL_RADIUS = 0.17  # footprint of the arm's pedestal box (arm.add_arm)


@dataclass(frozen=True)
class RobotKind:
    kind: str
    label: str
    add: Callable[[ET.Element, ET.Element, ET.Element, Any], None]  # (root, asset, worldbody, mount)
    rest: Callable[[Any], tuple[dict[str, float], dict[str, float]]]  # mount -> (qpos, ctrl) by name
    info: Callable[[Any], dict[str, Any]]  # mount -> scene.json entry (without id/kind/label)


def _round(values, digits: int = 4) -> list[float]:
    return [round(float(v), digits) for v in np.ravel(values)]


def _gripper(spec: arm.ArmSpec) -> dict[str, Any]:
    return {
        "actuator": spec.gripper_actuator,
        "open": spec.gripper_open,
        "fingers": list(spec.finger_joints),
        "max_width": round(spec.max_width, 4),
        "tip_below_grip": round(arm.TIP_BELOW_GRIP, 4),
    }


def _arm_fields(spec: arm.ArmSpec, position, yaw: float) -> dict[str, Any]:
    """The fields the web IK and grasp planner need for one arm (web/src/scene/bundle.ts ArmInfo)."""
    return {
        "base": spec.link_names[0],
        "position": _round(position),
        "yaw": round(float(yaw), 4),
        "joints": list(spec.joint_names),
        "home": list(arm.HOME),
        "stow": list(arm.STOW),
        "keyframe": KEYFRAME,
        "grip_site": spec.grip_site,
        "gripper": _gripper(spec),
        "reach_m": [REACH_MIN, REACH_MAX],
    }


def arm_info(mount: arm.ArmMount) -> dict[str, Any]:
    """scene.json entry of the stationary arm (also written under the old `arm` key)."""
    return {
        **_arm_fields(arm.STATIONARY, mount.position, mount.yaw),
        "pedestal_m": round(mount.pedestal_height, 3),
        "support": mount.support,
        "mocap": mount.mocap,
        "footprint_radius": BASE_RADIUS if mount.pedestal_height == 0 else PEDESTAL_RADIUS,
        "status_lights": [arm.STATIONARY.status_light],
    }


def mobile_info(mount: mobile.MobileMount) -> dict[str, Any]:
    x, y = (float(v) for v in mount.position[:2])
    arm_start = np.array([x + mobile.ARM_OFFSET * np.cos(mount.yaw), y + mobile.ARM_OFFSET * np.sin(mount.yaw), mobile.LIFT_BASE_Z + mobile.LIFT_HOME])
    arm_entry = {**_arm_fields(mobile.ARM, arm_start, mount.yaw), "pedestal_m": 0.0, "support": None}
    return {
        "base": mobile.BASE_BODY,
        "position": _round([x, y, 0.0]),
        "yaw": round(float(mount.yaw), 4),
        "near": mount.near,
        "reach_m": arm_entry["reach_m"],
        "gripper": arm_entry["gripper"],
        "footprint_radius": mobile.FOOTPRINT_RADIUS,
        "nav_margin": mobile.NAV_MARGIN,
        "arm_offset_m": mobile.ARM_OFFSET,
        "drive": {
            "joints": list(mobile.BASE_JOINTS),
            "actuators": list(mobile.BASE_JOINTS),
            "max_speed": mobile.MAX_SPEED,
            "max_accel": mobile.MAX_ACCEL,
            "max_turn_rate": mobile.MAX_TURN_RATE,
        },
        "lift": {
            "joint": mobile.LIFT_JOINT,
            "actuator": mobile.LIFT_JOINT,
            "range": [0.0, mobile.LIFT_TRAVEL],
            "arm_base_z": [mobile.LIFT_BASE_Z, round(mobile.LIFT_BASE_Z + mobile.LIFT_TRAVEL, 4)],
            "home": mobile.LIFT_HOME,
        },
        "arm": arm_entry,
        "keyframe": KEYFRAME,
        "status_lights": [mobile.STATUS_LIGHT, mobile.ARM.status_light],
    }


REGISTRY: dict[str, RobotKind] = {
    "arm": RobotKind("arm", "Arm", lambda root, asset, world, mount: arm.add_arm(root, asset, world, mount), lambda _: arm.rest_state(), arm_info),
    "mobile": RobotKind("mobile", "Mobile manipulator", mobile.add_mobile, mobile.rest_state, mobile_info),
}


def placed(scene: SimScene) -> list[tuple[str, RobotKind, Any]]:
    """(id, kind, mount) of every robot in the scene, in a stable order."""
    robots = []
    if scene.arm is not None:
        robots.append(("arm", REGISTRY["arm"], scene.arm))
    if scene.mobile is not None:
        robots.append(("mobile", REGISTRY["mobile"], scene.mobile))
    return robots


def add_robots(root: ET.Element, asset: ET.Element, worldbody: ET.Element, scene: SimScene) -> bool:
    """Append every robot of the scene to the MJCF; True when there is at least one."""
    robots = placed(scene)
    for _, kind, mount in robots:
        kind.add(root, asset, worldbody, mount)
    return bool(robots)


def rest_state(scene: SimScene) -> tuple[dict[str, float], dict[str, float]]:
    qpos: dict[str, float] = {}
    ctrl: dict[str, float] = {}
    for _, kind, mount in placed(scene):
        q, c = kind.rest(mount)
        qpos.update(q)
        ctrl.update(c)
    return qpos, ctrl


def metadata(scene: SimScene) -> list[dict[str, Any]]:
    return [{"id": robot_id, "kind": kind.kind, "label": kind.label, **kind.info(mount)} for robot_id, kind, mount in placed(scene)]
