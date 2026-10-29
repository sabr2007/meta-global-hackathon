"""Objective quality of a scene bundle: how closely every scanned object matches its capture.

One row per object:
- lidar_mm: mean distance from the object's LiDAR points to its mesh surface (needs the capture);
- size: extent of the mesh's visible surface / extent of the object's LiDAR points (both as the photo
  sees them) along the mesh's principal ground axes and up from its base: length, width, height;
  1.00 is a match (needs the capture);
- tilt_deg: angle between the mesh's up axis (the normal of the base its convex hull stands on) and
  the table normal (+Z);
- drift_cm: how far the body moves in the first SETTLE_SECONDS of simulation;
- color_de: CIE76 difference between the object's mean colour in the hero photo (inside its mask)
  and the mean colour of the visible side of its mesh;
- iou: photo camera vs placed mesh, as stored in scene.json (camera.alignment).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import mujoco
import numpy as np
import trimesh
from PIL import Image

from scan2sim.capture import load_capture
from scan2sim.color import delta_e, srgb_to_lab
from scan2sim.frames import WorldFrame
from scan2sim.hero import HERO_FILE, PhotoCamera, full_raster, load_masks
from scan2sim.images import load_upright
from scan2sim.lift import MASK_ERODE_PX, erode, lift_masks
from scan2sim.object_mesh import surface_distances, surface_samples, tilt_deg, up_axis
from scan2sim.perceive import MODEL_MAX_SIDE
from scan2sim.segmentation import ObjectMask

SETTLE_SECONDS = 2.0
EXTENT_PERCENTILES = (5.0, 95.0)  # trims LiDAR noise; the same cut is applied to the mesh


@dataclass(frozen=True)
class ObjectQuality:
    name: str
    label: str
    lidar_mm: float | None
    size: tuple[float, float, float] | None  # length, width, height ratios (mesh / LiDAR)
    tilt_deg: float
    drift_cm: float
    color_de: float | None
    iou: float | None


def settle_drift(mjcf: Path, bodies: list[str], seconds: float = SETTLE_SECONDS) -> dict[str, float]:
    """How far each body moves in the first seconds: a few mm means it rests where it was scanned."""
    model = mujoco.MjModel.from_xml_path(str(mjcf))
    data = mujoco.MjData(model)
    if model.nkey:
        mujoco.mj_resetDataKeyframe(model, data, 0)
    mujoco.mj_forward(model, data)
    start = {name: data.body(name).xpos.copy() for name in bodies}
    for _ in range(int(seconds / model.opt.timestep)):
        mujoco.mj_step(model, data)
    return {name: float(np.linalg.norm(data.body(name).xpos - start[name])) for name in bodies}


def ground_axes(points: np.ndarray) -> np.ndarray:
    """(2, 2) principal axes of the points' footprint on the ground, major axis first."""
    xy = np.asarray(points, dtype=np.float64)[:, :2]
    _, _, axes = np.linalg.svd(xy - xy.mean(axis=0), full_matrices=False)
    return axes


def robust_extents(points: np.ndarray, axes: np.ndarray, base_z: float) -> np.ndarray:
    """Spread along both ground axes and height of the top above base_z, within EXTENT_PERCENTILES."""
    points = np.asarray(points, dtype=np.float64)
    low, high = np.percentile(points[:, :2] @ axes.T, EXTENT_PERCENTILES, axis=0)
    return np.array([*(high - low), np.percentile(points[:, 2], EXTENT_PERCENTILES[1]) - base_z])


def mean_color_difference(photo: np.ndarray, mask: np.ndarray, colors: np.ndarray) -> float | None:
    """ΔE between the mean CIELAB colour of the photo inside the (eroded) mask and of `colors` (sRGB)."""
    inside = erode(mask, MASK_ERODE_PX)
    if not inside.any() or not len(colors):
        return None
    photo_lab = srgb_to_lab(photo[inside][:, :3]).mean(axis=0)
    return float(delta_e(photo_lab, srgb_to_lab(np.asarray(colors)[:, :3]).mean(axis=0)))


def object_quality(
    name: str,
    label: str,
    mesh_world: trimesh.Trimesh,
    camera: PhotoCamera | None,
    photo: np.ndarray | None,
    mask: ObjectMask | None,
    lidar_points: np.ndarray | None,
    drift_m: float,
    iou: float | None,
) -> ObjectQuality:
    """All metrics of one object whose mesh is already placed in the world."""
    vertices = np.asarray(mesh_world.vertices, dtype=np.float64)
    surface = surface_samples(mesh_world)
    lidar_mm = size = color_de = None
    if camera is not None and lidar_points is not None and len(lidar_points):
        lidar_mm = float(surface_distances(vertices, mesh_world.faces, lidar_points).mean() * 1000)
        axes, base_z = ground_axes(surface), float(vertices[:, 2].min())
        seen = surface[camera.seen(surface, surface)]
        ratio = robust_extents(seen, axes, base_z) / robust_extents(lidar_points, axes, base_z)
        size = tuple(round(float(v), 3) for v in ratio)
    if camera is not None and photo is not None and mask is not None:
        colors = np.asarray(mesh_world.visual.vertex_colors)
        color_de = mean_color_difference(photo, full_raster(mask, (camera.width, camera.height)), colors[camera.seen(vertices, surface)])
    return ObjectQuality(name, label, lidar_mm, size, tilt_deg(up_axis(vertices)), drift_m * 100, color_de, iou)


def lidar_points(capture_dir: Path, photo_stem: str, masks: dict[str, ObjectMask], frame: WorldFrame) -> dict[str, np.ndarray]:
    """The LiDAR points of every mask, lifted exactly as `scan2sim objects` lifts them."""
    capture = load_capture(capture_dir)
    photo = capture.root / "photos" / f"{photo_stem}.jpg"
    view = next((v for v in capture.photos if v.image == photo), None)
    if view is None:
        raise FileNotFoundError(f"photo not found: {photo}")
    image = load_upright(photo, max_side=MODEL_MAX_SIDE)
    lifted = {id(o.mask): o.points_world for o in lift_masks(capture, view, image, list(masks.values()), frame)}
    return {name: lifted[id(mask)] for name, mask in masks.items() if id(mask) in lifted}


def placed_mesh(bundle: Path, entry: dict) -> trimesh.Trimesh:
    """An object's bundle mesh moved from its body frame to its start pose in the world."""
    mesh = trimesh.load(bundle / entry["mesh"], file_type="glb", force="mesh")
    mesh.apply_translation(np.asarray(entry["start"], dtype=np.float64))
    return mesh


def report(bundle: Path, capture: Path | None = None, photo_stem: str | None = None) -> list[ObjectQuality]:
    """Quality rows for every scanned object of a bundle; LiDAR columns need the capture and photo."""
    meta = json.loads((bundle / "scene.json").read_text())
    objects = meta.get("objects") or []
    camera_block = meta.get("camera")
    camera = PhotoCamera.from_metadata(camera_block) if camera_block else None
    masks = load_masks(bundle)
    photo = np.asarray(Image.open(bundle / HERO_FILE).convert("RGB")) if (bundle / HERO_FILE).exists() else None
    points = {}
    if capture is not None and photo_stem is not None and masks:
        points = lidar_points(capture, photo_stem, masks, WorldFrame.from_matrix(meta["frame"]["arkit_to_world"]))
    drift = settle_drift(bundle / meta["files"]["mjcf"], [o["body"] for o in objects])
    alignment = (camera_block or {}).get("alignment", {})
    return [
        object_quality(
            o["name"], o["label"], placed_mesh(bundle, o), camera, photo, masks.get(o["name"]), points.get(o["name"]),
            drift[o["body"]], alignment.get(o["name"], {}).get("iou"),
        )
        for o in objects
    ]


def _cell(value: float | None, spec: str) -> str:
    return "-" if value is None else format(value, spec)


def format_table(rows: list[ObjectQuality]) -> str:
    """Fixed-width table with a median row (per column; per axis for the size ratios)."""
    lines = [f"{'object':<24}{'lidar mm':>9}  {'size L / W / H':>18}{'tilt°':>7}{'drift cm':>9}{'ΔE':>7}{'IoU':>6}"]
    for r in rows:
        size = " / ".join(f"{v:.2f}" for v in r.size) if r.size else "-"
        lines.append(
            f"{r.label[:23]:<24}{_cell(r.lidar_mm, '.1f'):>9}  {size:>18}{r.tilt_deg:>7.1f}{r.drift_cm:>9.2f}"
            f"{_cell(r.color_de, '.1f'):>7}{_cell(r.iou, '.2f'):>6}"
        )
    median = lambda values: float(np.median(values)) if values else None  # noqa: E731
    sizes = np.array([r.size for r in rows if r.size])
    size = " / ".join(f"{v:.2f}" for v in np.median(sizes, axis=0)) if len(sizes) else "-"
    lines.append(
        f"{'median':<24}{_cell(median([r.lidar_mm for r in rows if r.lidar_mm is not None]), '.1f'):>9}  {size:>18}"
        f"{_cell(median([r.tilt_deg for r in rows]), '.1f'):>7}{_cell(median([r.drift_cm for r in rows]), '.2f'):>9}"
        f"{_cell(median([r.color_de for r in rows if r.color_de is not None]), '.1f'):>7}"
        f"{_cell(median([r.iou for r in rows if r.iou is not None]), '.2f'):>6}"
    )
    return "\n".join(lines)


def rows_json(rows: list[ObjectQuality]) -> str:
    return json.dumps([asdict(r) for r in rows], indent=1) + "\n"
