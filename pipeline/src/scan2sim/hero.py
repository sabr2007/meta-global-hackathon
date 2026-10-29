"""The hero photo as the viewer sees it: an upright JPEG, its pinhole camera in the world frame and
the SAM 3.1 mask of every scanned object (the "before" state Ayna compares imagined photos with).

Camera convention (three.js): the camera looks down its local -Z and +Y is up in the upright image.
Pixel coordinates are upright image pixels, x right, y down.
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import trimesh
from PIL import Image, ImageDraw

from scan2sim.capture import CameraView
from scan2sim.frames import ARKIT_TO_ZUP, WorldFrame
from scan2sim.images import UprightImage
from scan2sim.scene import ScannedObject
from scan2sim.segmentation import ObjectMask

HERO_FILE = "hero.jpg"
MASKS_FILE = "masks.json"
HERO_JPEG_QUALITY = 88
MIN_DEPTH_M = 0.02
GL_TO_CV = np.diag([1.0, -1.0, -1.0])  # OpenGL camera axes (y up, z back) <-> computer vision (y down, z forward)
DEPTH_CELL_PX = 3  # z-buffer resolution for visibility tests
VISIBLE_SLACK_M = 0.004  # a point this close behind the nearest surface in its cell is still seen


@dataclass(frozen=True)
class PhotoCamera:
    width: int
    height: int
    fx: float
    fy: float
    cx: float
    cy: float
    camera_to_world: np.ndarray  # 4x4, world frame, OpenGL camera axes

    def project(self, points_world: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(N, 3) world points -> (N, 2) upright pixels and (N,) depth along the view axis."""
        rotation = self.camera_to_world[:3, :3]
        local = (np.asarray(points_world, dtype=np.float64) - self.camera_to_world[:3, 3]) @ rotation
        cv = local @ GL_TO_CV
        depth = cv[:, 2]
        safe = np.where(depth > MIN_DEPTH_M, depth, MIN_DEPTH_M)
        pixels = np.column_stack([self.fx * cv[:, 0] / safe + self.cx, self.fy * cv[:, 1] / safe + self.cy])
        return pixels, depth

    def metadata(self) -> dict[str, Any]:
        return {
            "image": HERO_FILE,
            "width": self.width,
            "height": self.height,
            "fx": round(self.fx, 3),
            "fy": round(self.fy, 3),
            "cx": round(self.cx, 3),
            "cy": round(self.cy, 3),
            "camera_to_world": np.round(self.camera_to_world, 6).tolist(),
        }

    @classmethod
    def from_metadata(cls, block: dict[str, Any]) -> PhotoCamera:
        """The camera of a bundle's scene.json `camera` block."""
        return cls(
            int(block["width"]), int(block["height"]), float(block["fx"]), float(block["fy"]),
            float(block["cx"]), float(block["cy"]), np.asarray(block["camera_to_world"], dtype=np.float64),
        )

    def facing(self, points_world: np.ndarray, normals_world: np.ndarray) -> np.ndarray:
        """Cosine between each surface normal and the direction to the camera (1 = head-on, < 0 = away)."""
        to_camera = self.camera_to_world[:3, 3] - np.asarray(points_world, dtype=np.float64)
        to_camera /= np.linalg.norm(to_camera, axis=1, keepdims=True)
        normals = np.asarray(normals_world, dtype=np.float64)
        return np.einsum("ij,ij->i", normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12), to_camera)

    def seen(self, points_world: np.ndarray, surface_world: np.ndarray, cell_px: int = DEPTH_CELL_PX) -> np.ndarray:
        """Which points the photo shows: in front, inside the frame, and not hidden behind `surface_world`
        (dense samples of everything that can occlude them, e.g. the object's own surface)."""
        cells_w = self.width // cell_px + 1
        nearest = np.full(cells_w * (self.height // cell_px + 1), np.inf)
        cells, depth, inside = self._cells(surface_world, cell_px, cells_w)
        np.minimum.at(nearest, cells[inside], depth[inside])
        cells, depth, inside = self._cells(points_world, cell_px, cells_w)
        return inside & (depth <= nearest[np.where(inside, cells, 0)] + VISIBLE_SLACK_M)

    def _cells(self, points_world: np.ndarray, cell_px: int, cells_w: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        pixels, depth = self.project(points_world)
        inside = (depth > MIN_DEPTH_M) & (pixels[:, 0] >= 0) & (pixels[:, 0] < self.width) & (pixels[:, 1] >= 0) & (pixels[:, 1] < self.height)
        cell = np.where(inside[:, None], pixels, 0.0).astype(np.int64) // cell_px
        return cell[:, 1] * cells_w + cell[:, 0], depth, inside


def upright_camera(view: CameraView, image: UprightImage, frame: WorldFrame) -> PhotoCamera:
    """The photo's ARKit camera re-expressed for the upright (possibly scaled) image.

    Turning the image by quarter turns is a rotation about the optical axis plus a pixel shift, so
    the affine map sensor -> upright pixels splits into new intrinsics and a rolled camera.
    """
    origin, x_step, y_step = image.from_sensor(np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]))
    linear = np.column_stack([x_step - origin, y_step - origin])  # scale * quarter-turn rotation
    scale = float(np.sqrt(abs(np.linalg.det(linear))))
    turn = linear / scale
    k = view.intrinsics
    focal = scale * np.abs(turn @ np.diag([k[0, 0], k[1, 1]]) @ turn.T).diagonal()
    principal = scale * turn @ np.array([k[0, 2], k[1, 2]]) + origin
    roll = np.eye(3)
    roll[:2, :2] = turn
    rotation_arkit = view.camera_to_world[:3, :3] @ GL_TO_CV @ roll.T @ GL_TO_CV
    pose = np.eye(4)
    pose[:3, :3] = ARKIT_TO_ZUP @ rotation_arkit
    pose[:3, 3] = frame.points(view.camera_to_world[:3, 3][None, :])[0]
    width, height = image.image.size
    return PhotoCamera(width, height, float(focal[0]), float(focal[1]), float(principal[0]), float(principal[1]), pose)


def encode_rle(mask: ObjectMask) -> dict[str, Any]:
    """Row-major run lengths over the mask's own raster, starting with a (possibly empty) run of 0s."""
    flat = mask.mask.reshape(-1).astype(np.int8)
    changes = np.flatnonzero(np.diff(flat)) + 1
    edges = np.concatenate([[0], changes, [flat.size]])
    counts = np.diff(edges).tolist()
    if flat.size and flat[0]:
        counts = [0, *counts]
    height, width = mask.mask.shape
    return {"x": int(mask.mask_origin[0]), "y": int(mask.mask_origin[1]), "w": int(width), "h": int(height), "counts": counts}


def decode_rle(rle: dict[str, Any]) -> np.ndarray:
    """The mask raster of an `encode_rle` entry (its origin is rle["x"], rle["y"])."""
    values = np.arange(len(rle["counts"])) % 2 == 1
    return np.repeat(values, rle["counts"]).reshape(int(rle["h"]), int(rle["w"]))


def load_masks(bundle: Path) -> dict[str, ObjectMask]:
    """The SAM 3.1 mask of every object in a bundle's masks.json, by body name."""
    path = bundle / MASKS_FILE
    if not path.exists():
        return {}
    masks = {}
    for entry in json.loads(path.read_text())["masks"]:
        rle = entry["rle"]
        origin = (int(rle["x"]), int(rle["y"]))
        masks[entry["object"]] = ObjectMask(entry["concept"], entry["object"], tuple(entry["box"]), None, origin, decode_rle(rle))
    return masks


def full_raster(mask: ObjectMask, size: tuple[int, int]) -> np.ndarray:
    width, height = size
    canvas = np.zeros((height, width), dtype=bool)
    x0, y0 = mask.mask_origin
    h, w = mask.mask.shape
    canvas[y0 : y0 + h, x0 : x0 + w] = mask.mask[: height - y0, : width - x0]
    return canvas


def silhouette(camera: PhotoCamera, vertices_world: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Boolean raster of a mesh seen through the photo camera."""
    pixels, depth = camera.project(vertices_world)
    canvas = Image.new("1", (camera.width, camera.height), 0)
    draw = ImageDraw.Draw(canvas)
    for face in faces:
        if (depth[face] <= MIN_DEPTH_M).any():
            continue
        draw.polygon([tuple(p) for p in pixels[face]], fill=1)
    return np.asarray(canvas, dtype=bool)


def alignment(camera: PhotoCamera, obj: ScannedObject, mask: ObjectMask) -> dict[str, float]:
    """How well the placed mesh, seen from the photo camera, covers the object's SAM mask."""
    mesh = trimesh.load(io.BytesIO(obj.visual_glb), file_type="glb", force="mesh")
    rendered = silhouette(camera, mesh.vertices + obj.position, mesh.faces)
    observed = full_raster(mask, (camera.width, camera.height))
    union = np.logical_or(rendered, observed).sum()
    iou = float(np.logical_and(rendered, observed).sum() / union) if union else 0.0
    centroid = lambda m: np.argwhere(m).mean(axis=0)[::-1] if m.any() else np.array([np.nan, np.nan])  # noqa: E731
    offset = float(np.linalg.norm(centroid(rendered) - centroid(observed)))
    return {"iou": round(iou, 3), "centroid_offset_px": round(offset, 1)}


def write_hero(
    out_dir: Path,
    image: UprightImage,
    camera: PhotoCamera,
    objects: tuple[ScannedObject, ...],
    masks: dict[str, ObjectMask],
    concepts: dict[str, str],
) -> dict[str, Any]:
    """Write hero.jpg and masks.json; return the camera block for scene.json (with alignment)."""
    image.image.save(out_dir / HERO_FILE, "JPEG", quality=HERO_JPEG_QUALITY)
    entries = []
    checks = {}
    for obj in objects:
        mask = masks.get(obj.name)
        if mask is None:
            continue
        checks[obj.name] = alignment(camera, obj, mask)
        entries.append(
            {
                "object": obj.name,
                "concept": concepts.get(obj.name, mask.concept),
                "box": [int(v) for v in mask.box],
                "area_px": mask.area_px,
                "rle": encode_rle(mask),
            }
        )
    (out_dir / MASKS_FILE).write_text(json.dumps({"width": camera.width, "height": camera.height, "masks": entries}) + "\n")
    return {**camera.metadata(), "masks": MASKS_FILE, "alignment": checks}
