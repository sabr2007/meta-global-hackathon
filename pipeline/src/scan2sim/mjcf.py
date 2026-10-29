"""SimScene -> MuJoCo MJCF XML."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import mujoco
import numpy as np
import trimesh

from scan2sim import arm
from scan2sim.frames import quat_from_matrix
from scan2sim.scene import Box, ScannedObject, SimScene

FLOOR_MARGIN = 1.0  # extra plane size around the scanned floor (render size only)
SCANNED_DENSITY = 600.0  # kg/m^3 for objects without a Muse Spark mass
COLLIDER_ALPHA = 0.35
FURNITURE_CONTYPE = 4  # collides with contype-1 bodies (objects, probes) but not the arm (arm.ARM_CONTYPE)
SCANNED_FRICTION = (0.9, 0.005, 0.0001)  # sliding, torsional, rolling; Muse Spark can set the sliding one

# Geom groups let the viewer toggle layers.
GROUP_PROBES = 0
GROUP_STRUCTURE = 1
GROUP_FURNITURE = 2
GROUP_OPENINGS = 3
GROUP_SCANNED = 4  # convex colliders of scanned objects; the viewer draws their meshes instead

KIND_RGBA = {
    "floor": (0.82, 0.80, 0.76, 1.0),
    "wall": (0.90, 0.89, 0.86, 0.35),
    "window": (0.55, 0.75, 0.95, 0.35),
    "door": (0.70, 0.55, 0.40, 0.35),
    "opening": (0.60, 0.60, 0.60, 0.25),
    "object": (0.86, 0.75, 0.58, 0.4),
}


def _fmt(values) -> str:
    return " ".join(f"{float(v):.5g}" for v in np.ravel(values))


def _box_geom(parent: ET.Element, box: Box) -> None:
    if box.kind in ("window", "door", "opening"):
        group = GROUP_OPENINGS
    elif box.kind == "object":
        group = GROUP_FURNITURE
    else:
        group = GROUP_STRUCTURE
    contype = 0
    if box.collides:
        # RoomPlan furniture boxes are bounding boxes (a chair's includes the air around its
        # backrest): objects still land on them, but the arm only meets walls and tables.
        contype = FURNITURE_CONTYPE if box.kind == "object" and box.category != "table" else 1
    ET.SubElement(
        parent,
        "geom",
        name=box.name,
        type="box",
        pos=_fmt(box.center),
        quat=_fmt(quat_from_matrix(box.rotation)),
        size=_fmt(np.maximum(box.half_size, 1e-3)),
        rgba=_fmt(KIND_RGBA[box.kind]),
        group=str(group),
        contype=str(contype),
        conaffinity="1" if box.collides else "0",
    )


def _mesh_asset(asset: ET.Element, name: str, vertices: np.ndarray, faces: np.ndarray) -> None:
    ET.SubElement(asset, "mesh", name=name, vertex=_fmt(vertices), face=" ".join(str(int(i)) for i in np.ravel(faces)))


def _hull_mesh(asset: ET.Element, obj: ScannedObject) -> None:
    _mesh_asset(asset, f"{obj.name}_hull", obj.hull_vertices, obj.hull_faces)
    for i, (vertices, faces) in enumerate(obj.collider_pieces):
        _mesh_asset(asset, f"{obj.name}_piece{i}", vertices, faces)


def _physical(obj: ScannedObject, shapes: list[tuple[np.ndarray, np.ndarray]]) -> list[dict[str, str]]:
    """Per colliding shape: its share of the object's estimated mass (by volume) and its friction."""
    if obj.mass_kg is None:
        return [{} for _ in shapes]
    volumes = np.array([trimesh.Trimesh(vertices, faces).volume for vertices, faces in shapes])
    friction = _fmt([obj.friction, *SCANNED_FRICTION[1:]])
    return [{"mass": _fmt([obj.mass_kg * v / volumes.sum()]), "friction": friction} for v in volumes]


def _scanned_body(parent: ET.Element, obj: ScannedObject) -> None:
    body = ET.SubElement(parent, "body", name=obj.name, pos=_fmt(obj.position))
    ET.SubElement(body, "freejoint", name=f"{obj.name}_free")
    rgba = _fmt([*obj.rgba[:3], COLLIDER_ALPHA])
    hull = ET.SubElement(body, "geom", {"class": "scanned"}, name=f"{obj.name}_geom", type="mesh", mesh=f"{obj.name}_hull", rgba=rgba)
    if not obj.collider_pieces:
        hull.attrib.update(_physical(obj, [(obj.hull_vertices, obj.hull_faces)])[0])
        return
    # The pieces collide and weigh; the whole hull stays as the object's outline (the arm plans grasps on it).
    hull.attrib.update(contype="0", conaffinity="0", mass="0")
    for i, physical in enumerate(_physical(obj, list(obj.collider_pieces))):
        ET.SubElement(
            body, "geom", {"class": "scanned", **physical}, name=f"{obj.name}_piece{i}", type="mesh", mesh=f"{obj.name}_piece{i}", rgba=rgba
        )


def _add_home_key(root: ET.Element) -> None:
    """Keyframe 0: everything where the scene puts it, the arm in its home pose, gripper open."""
    model = mujoco.MjModel.from_xml_string(ET.tostring(root, encoding="unicode"))
    qpos = model.qpos0.copy()
    ctrl = np.zeros(model.nu)
    targets = {**dict(zip(arm.JOINT_NAMES, arm.HOME)), **{f: arm.GRIPPER_OPEN for f in arm.FINGER_JOINTS}}
    for name, value in targets.items():
        qpos[model.jnt_qposadr[model.joint(name).id]] = value
    for name, value in zip((*arm.JOINT_NAMES, arm.GRIPPER_ACTUATOR), arm.home_ctrl()):
        ctrl[model.actuator(name).id] = value
    keyframe = ET.SubElement(root, "keyframe")
    ET.SubElement(keyframe, "key", name="home", qpos=" ".join(f"{v:.6g}" for v in qpos), ctrl=" ".join(f"{v:.6g}" for v in ctrl))


def scene_to_mjcf(scene: SimScene, model_name: str = "scanned-room") -> str:
    root = ET.Element("mujoco", model=model_name)
    ET.SubElement(root, "compiler", angle="radian", autolimits="true")
    # Elliptic friction cones and a no-slip pass: held objects don't creep out of the fingers.
    option = ET.SubElement(
        root, "option", timestep="0.002", integrator="implicitfast", cone="elliptic", noslip_iterations="4"
    )
    # Several contact points per convex pair: flat faces rest (and get gripped) without rocking.
    ET.SubElement(option, "flag", multiccd="enable")

    default = ET.SubElement(root, "default")
    probe_default = ET.SubElement(default, "default", {"class": "probe"})
    ET.SubElement(probe_default, "geom", density="600", friction="0.9 0.005 0.0001", group=str(GROUP_PROBES))
    scanned_default = ET.SubElement(default, "default", {"class": "scanned"})
    ET.SubElement(
        scanned_default, "geom", density=_fmt([SCANNED_DENSITY]), friction=_fmt(SCANNED_FRICTION), group=str(GROUP_SCANNED)
    )

    asset = ET.SubElement(root, "asset")
    for obj in scene.objects:
        _hull_mesh(asset, obj)

    worldbody = ET.SubElement(root, "worldbody")
    ET.SubElement(worldbody, "light", name="ceiling_light", pos="0 0 2.5", dir="0 0 -1", diffuse="0.8 0.8 0.8")

    floor_half = scene.floor.half_size[:2] + FLOOR_MARGIN
    ET.SubElement(
        worldbody,
        "geom",
        name="floor",
        type="plane",
        pos=_fmt([scene.floor.center[0], scene.floor.center[1], 0.0]),
        size=_fmt([floor_half.max(), floor_half.max(), 0.1]),
        rgba=_fmt(KIND_RGBA["floor"]),
        group=str(GROUP_STRUCTURE),
    )
    for box in scene.boxes:
        _box_geom(worldbody, box)

    for probe in scene.probes:
        half_yaw = probe.yaw / 2
        body = ET.SubElement(
            worldbody,
            "body",
            name=probe.name,
            pos=_fmt(probe.position),
            quat=_fmt([np.cos(half_yaw), 0.0, 0.0, np.sin(half_yaw)]),
        )
        ET.SubElement(body, "freejoint", name=f"{probe.name}_free")
        ET.SubElement(
            body,
            "geom",
            {"class": "probe"},
            name=f"{probe.name}_geom",
            type=probe.shape,
            size=_fmt(probe.size),
            rgba=_fmt(probe.rgba),
        )

    for obj in scene.objects:
        _scanned_body(worldbody, obj)

    if scene.arm is not None:
        arm.add_arm(root, asset, worldbody, scene.arm)
        _add_home_key(root)

    ET.indent(root)
    return ET.tostring(root, encoding="unicode") + "\n"
