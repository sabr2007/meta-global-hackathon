"""Write the viewer bundle: scene.xml (physics), room_mesh.glb (visuals), scene.json (metadata),
objects/<name>.glb (meshes of scanned objects, in their body frames)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import trimesh

from scan2sim import arm
from scan2sim.capture import Capture, CapturedRoom
from scan2sim.frames import WorldFrame
from scan2sim.lidar_mesh import FACE_CLASSES, LidarMesh
from scan2sim.mjcf import scene_to_mjcf
from scan2sim.mount import REACH_MAX, REACH_MIN
from scan2sim.scene import ScannedObject, SimScene

BUNDLE_FORMAT = "scan2sim/scene@1"
CEILING_CLASS = FACE_CLASSES.index("ceiling")
OBJECTS_DIR = "objects"


@dataclass(frozen=True)
class BundlePaths:
    mjcf: Path
    mesh: Path
    metadata: Path


def _submesh(mesh: LidarMesh, frame: WorldFrame, face_mask: np.ndarray) -> trimesh.Trimesh:
    faces = mesh.faces[face_mask]
    used, remapped = np.unique(faces, return_inverse=True)
    return trimesh.Trimesh(
        vertices=frame.points(mesh.vertices[used]),
        faces=remapped.reshape(-1, 3),
        vertex_normals=frame.directions(mesh.normals[used]),
        vertex_colors=np.column_stack([mesh.colors[used], np.full(len(used), 255, np.uint8)]),
        process=False,
    )


def export_room_mesh(mesh: LidarMesh, frame: WorldFrame, path: Path) -> dict[str, int]:
    """Room surfaces as a GLB in world coordinates (+Z up). The ceiling is its own node."""
    inside = mesh.in_room[mesh.faces].all(axis=1)
    is_ceiling = mesh.face_class == CEILING_CLASS
    gltf = trimesh.Scene()
    stats = {}
    for node, mask in (("room", inside & ~is_ceiling), ("ceiling", inside & is_ceiling)):
        if mask.any():
            gltf.add_geometry(_submesh(mesh, frame, mask), node_name=node, geom_name=node)
            stats[f"{node}_faces"] = int(mask.sum())
    path.write_bytes(gltf.export(file_type="glb"))
    return stats


def _box_metadata(box) -> dict[str, Any]:
    width, height, depth = (box.half_size * 2).tolist()
    return {
        "name": box.name,
        "kind": box.kind,
        "category": box.category,
        "confidence": box.confidence,
        "dimensions_m": {"width": round(width, 3), "depth": round(depth, 3), "height": round(height, 3)},
        "center": [round(v, 4) for v in box.center.tolist()],
        "top_z": round(box.top_z, 4),
        "collides": box.collides,
        "attributes": box.attributes,
        "source_id": box.source_id,
    }


def scene_metadata(
    capture: Capture, room: CapturedRoom, scene: SimScene, mesh_stats: dict[str, int], camera: dict[str, Any] | None = None
) -> dict[str, Any]:
    manifest = capture.manifest
    return {
        "format": BUNDLE_FORMAT,
        "source": {
            "format": manifest.get("format"),
            "device": manifest.get("device"),
            "captured_at": manifest.get("createdAt"),
            "room_index": room.index,
            "room_name": room.name,
            "photos": len(capture.photos),
            "depth_frames": len(capture.depth_frames),
        },
        "room": {
            "label": scene.room_label,
            "floor_m": [round(v, 3) for v in (scene.floor.half_size[:2] * 2).tolist()],
        },
        "frame": {
            "description": "world: meters, +Z up, floor at z=0, origin at floor centre",
            "arkit_to_world": np.round(scene.frame.matrix, 6).tolist(),
        },
        "elements": [_box_metadata(b) for b in scene.boxes],
        "probes": [
            {"name": p.name, "shape": p.shape, "size": list(p.size), "start": [round(v, 4) for v in p.position.tolist()]}
            for p in scene.probes
        ],
        "objects": [_object_metadata(o) for o in scene.objects],
        "arm": _arm_metadata(scene.arm) if scene.arm else None,
        "camera": camera,
        "mesh": mesh_stats,
        "files": {"mjcf": "scene.xml", "mesh": "room_mesh.glb"},
    }


def _object_metadata(obj: ScannedObject) -> dict[str, Any]:
    return {
        "name": obj.name,
        "label": obj.label,
        "concept": obj.concept,
        "body": obj.name,
        "mesh": f"{OBJECTS_DIR}/{obj.name}.glb",
        "size_m": [round(v, 3) for v in obj.size.tolist()],
        "start": [round(v, 4) for v in obj.position.tolist()],
        "depth_scale": round(obj.depth_scale, 3),
        "fit_error_mm": round(obj.fit_error_m * 1000, 1),
    }


def _arm_metadata(mount: arm.ArmMount) -> dict[str, Any]:
    return {
        "base": arm.LINK_NAMES[0],
        "position": [round(v, 4) for v in mount.position.tolist()],
        "yaw": round(mount.yaw, 4),
        "pedestal_m": round(mount.pedestal_height, 3),
        "support": mount.support,
        "joints": list(arm.JOINT_NAMES),
        "home": list(arm.HOME),
        "keyframe": "home",
        "grip_site": arm.GRIP_SITE,
        "gripper": {
            "actuator": arm.GRIPPER_ACTUATOR,
            "open": arm.GRIPPER_OPEN,
            "fingers": list(arm.FINGER_JOINTS),
            "max_width": round(2 * arm.FINGER_TRAVEL, 4),
            "tip_below_grip": round(arm.PALM_BOTTOM + arm.FINGER_LENGTH - arm.GRIP_POINT, 4),
        },
        "reach_m": [REACH_MIN, REACH_MAX],
    }


def write_bundle(
    capture: Capture,
    room: CapturedRoom,
    scene: SimScene,
    mesh: LidarMesh,
    out_dir: Path,
    hero: Callable[[Path], dict[str, Any]] | None = None,
) -> BundlePaths:
    """`hero` writes the photo files into the bundle and returns the camera block for scene.json."""
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = BundlePaths(mjcf=out_dir / "scene.xml", mesh=out_dir / "room_mesh.glb", metadata=out_dir / "scene.json")
    paths.mjcf.write_text(scene_to_mjcf(scene, model_name=f"room-{room.index}"))
    if scene.objects:
        (out_dir / OBJECTS_DIR).mkdir(exist_ok=True)
        for obj in scene.objects:
            (out_dir / OBJECTS_DIR / f"{obj.name}.glb").write_bytes(obj.visual_glb)
    mesh_stats = export_room_mesh(mesh, scene.frame, paths.mesh)
    camera = hero(out_dir) if hero else None
    paths.metadata.write_text(json.dumps(scene_metadata(capture, room, scene, mesh_stats, camera), indent=2) + "\n")
    return paths
