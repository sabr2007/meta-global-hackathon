"""Lift 2D object masks from a photo to metric 3D points using LiDAR depth frames.

Photos carry no depth, but depth frames recorded around the same moment do.
Unproject those depth maps to ARKit world points, project the points into the
photo, keep the ones that are visible (z-buffer) and fall inside a mask.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from scan2sim.capture import Capture, CameraView, DepthFrame, read_depth
from scan2sim.frames import WorldFrame
from scan2sim.images import UprightImage
from scan2sim.segmentation import ObjectMask

DEPTH_FRAMES_PER_PHOTO = 6
MIN_CONFIDENCE = 2  # ARKit depth confidence: 0 low, 1 medium, 2 high
ZBUFFER_BIN_PX = 4
VISIBLE_SLACK_M = 0.025  # a point within this of the nearest surface counts as visible
MASK_ERODE_PX = 3  # stay away from mask borders where depth bleeds into the background
MAD_CUTOFF = 3.0
MIN_POINTS = 30


@dataclass(frozen=True)
class LiftedObject:
    mask: ObjectMask
    points_world: np.ndarray  # (N, 3) in the simulation world frame
    center: np.ndarray  # centre of the axis-aligned box in world
    extents: np.ndarray  # oriented extents: length, width (xy, PCA), height (z)
    yaw: float  # radians, orientation of the PCA major axis in the xy plane
    bottom_z: float
    top_z: float


def nearest_depth_frames(capture: Capture, photo: CameraView, count: int = DEPTH_FRAMES_PER_PHOTO) -> list[DepthFrame]:
    return sorted(capture.depth_frames, key=lambda f: abs(f.view.timestamp - photo.timestamp))[:count]


def unproject(frame: DepthFrame) -> np.ndarray:
    """Confident depth pixels of one frame -> (N, 3) ARKit world points."""
    depth, confidence = read_depth(frame)
    rows, cols = np.nonzero((confidence >= MIN_CONFIDENCE) & np.isfinite(depth) & (depth > 0))
    d = depth[rows, cols].astype(np.float64)
    k = frame.view.intrinsics
    x = (cols + 0.5 - k[0, 2]) / k[0, 0] * d
    y = -(rows + 0.5 - k[1, 2]) / k[1, 1] * d  # image rows grow down, camera y up
    camera = np.column_stack([x, y, -d, np.ones_like(d)])  # ARKit camera looks down -Z
    return (camera @ frame.view.camera_to_world.T)[:, :3]


def project_points(view: CameraView, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(N, 3) ARKit points -> (N, 2) sensor pixels and (N,) depth along the view direction."""
    world_to_camera = np.linalg.inv(view.camera_to_world)
    cam = np.column_stack([points, np.ones(len(points))]) @ world_to_camera.T
    depth = -cam[:, 2]
    safe = np.where(depth > 1e-6, depth, np.nan)
    k = view.intrinsics
    u = k[0, 0] * cam[:, 0] / safe + k[0, 2]
    v = k[1, 1] * -cam[:, 1] / safe + k[1, 2]
    return np.column_stack([u, v]), depth


def _erode(mask: np.ndarray, iterations: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(iterations):
        shrunk = out.copy()
        shrunk[1:, :] &= out[:-1, :]
        shrunk[:-1, :] &= out[1:, :]
        shrunk[:, 1:] &= out[:, :-1]
        shrunk[:, :-1] &= out[:, 1:]
        out = shrunk
    return out


def _robust(points_cam_depth: np.ndarray) -> np.ndarray:
    median = np.median(points_cam_depth)
    mad = np.median(np.abs(points_cam_depth - median)) * 1.4826 + 1e-4
    return np.abs(points_cam_depth - median) <= MAD_CUTOFF * mad


def _box_from_points(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    xy = points[:, :2]
    centered = xy - xy.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    major = vt[0]
    yaw = float(np.arctan2(major[1], major[0]))
    rot = np.array([[np.cos(yaw), np.sin(yaw)], [-np.sin(yaw), np.cos(yaw)]])
    local = centered @ rot.T
    lo, hi = np.percentile(local, 2, axis=0), np.percentile(local, 98, axis=0)
    z_lo, z_hi = np.percentile(points[:, 2], 2), np.percentile(points[:, 2], 98)
    mid_local = (lo + hi) / 2
    center_xy = xy.mean(axis=0) + mid_local @ rot
    center = np.array([center_xy[0], center_xy[1], (z_lo + z_hi) / 2])
    extents = np.array([hi[0] - lo[0], hi[1] - lo[1], z_hi - z_lo])
    return center, extents, yaw


def lift_masks(
    capture: Capture,
    photo: CameraView,
    image: UprightImage,
    masks: list[ObjectMask],
    frame: WorldFrame,
) -> list[LiftedObject]:
    frames = nearest_depth_frames(capture, photo)
    points = np.vstack([unproject(f) for f in frames])
    sensor_px, depth = project_points(photo, points)
    in_front = depth > 0
    upright_px = np.full_like(sensor_px, -1.0)
    upright_px[in_front] = image.from_sensor(sensor_px[in_front])
    width, height = image.image.size
    inside = in_front & (upright_px[:, 0] >= 0) & (upright_px[:, 0] < width) & (upright_px[:, 1] >= 0) & (upright_px[:, 1] < height)
    idx = np.nonzero(inside)[0]
    px = upright_px[idx].astype(int)

    # z-buffer on coarse bins: keep only points on the nearest visible surface
    bins = (px[:, 1] // ZBUFFER_BIN_PX) * (width // ZBUFFER_BIN_PX + 1) + px[:, 0] // ZBUFFER_BIN_PX
    nearest = np.full(bins.max() + 1, np.inf)
    np.minimum.at(nearest, bins, depth[idx])
    visible = depth[idx] <= nearest[bins] + VISIBLE_SLACK_M
    idx, px = idx[visible], px[visible]

    lifted = []
    for mask in masks:
        eroded = _erode(mask.mask, MASK_ERODE_PX)
        x0, y0 = mask.mask_origin
        local_x, local_y = px[:, 0] - x0, px[:, 1] - y0
        within = (local_x >= 0) & (local_x < eroded.shape[1]) & (local_y >= 0) & (local_y < eroded.shape[0])
        hit = np.zeros(len(px), dtype=bool)
        hit[within] = eroded[local_y[within], local_x[within]]
        chosen = idx[hit]
        if len(chosen) < MIN_POINTS:
            continue
        chosen = chosen[_robust(depth[chosen])]
        world = frame.points(points[chosen])
        center, extents, yaw = _box_from_points(world)
        lifted.append(
            LiftedObject(
                mask=mask,
                points_world=world,
                center=center,
                extents=extents,
                yaw=yaw,
                bottom_z=float(np.percentile(world[:, 2], 2)),
                top_z=float(np.percentile(world[:, 2], 98)),
            )
        )
    return lifted
