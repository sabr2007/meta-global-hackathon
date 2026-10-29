"""Place SAM 3D meshes in the simulation world.

SAM 3D gives each object's orientation and the ray from the camera to it, but its depth comes from
a monocular estimate (MoGe); on our captures objects come out ~15% too far and too big. Scaling a
camera-frame object about the camera centre leaves its image unchanged, so the pose is right up to
one factor k: the median ratio of LiDAR depth to mesh depth along the same pixel rays.

Conventions, measured on a real capture (mean LiDAR-to-mesh distance 6.6 mm over 7 objects; the
next best candidate out of 96 gave 10.6 mm):
- fal's GLB is glTF +Y up; SAM 3D's canonical frame is +Z up (the TRELLIS export rotation);
- the pose acts on row vectors, p = (s * v) @ R + t, with R from a (w, x, y, z) quaternion;
- the camera is PyTorch3D's (x left, y up, z forward) for the upright photo that was sent.

Before the depth is fitted the mesh is levelled: SAM 3D poses come out 1-13 degrees off the table
(the mouse on our desk 12.9), and a tilted base rocks down onto the table in the first steps of the
simulation. The mesh turns about its centre until the base of its convex hull is flat.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial.transform import Rotation

from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.images import UprightImage
from scan2sim.object_mesh import surface_distances, tilt_deg, up_axis
from scan2sim.reconstruct import ObjectPose

GLB_TO_SAM3D = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
PYTORCH3D_TO_CV = np.diag([-1.0, -1.0, 1.0])  # both look along +z; flip x left -> right, y up -> down
DEPTH_BIN_RAD = 0.004  # about 4 px at the photo's focal length
MIN_DEPTH_MATCHES = 20
LEVEL_MAX_DEG = 20.0  # a base tilted further is not a pose error (a book leaning on something)
LEVEL_DONE_DEG = 0.2
LEVEL_STEPS = 3  # the hull's base changes as it turns; three steps settle every object we scanned


@dataclass(frozen=True)
class Placement:
    vertices_world: np.ndarray  # (N, 3) mesh vertices in the simulation world
    depth_scale: float  # metric depth / SAM 3D depth
    fit_error_m: float  # mean distance from the object's LiDAR points to the placed mesh surface
    level_deg: float = 0.0  # tilt of the SAM 3D pose that levelling removed


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The smallest rotation that turns direction a into direction b."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    axis = np.cross(a / np.linalg.norm(a), b / np.linalg.norm(b))
    sine, cosine = np.linalg.norm(axis), float(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b))
    if sine < 1e-12:
        return np.eye(3)
    return Rotation.from_rotvec(axis / sine * np.arctan2(sine, cosine)).as_matrix()


def level_rotation(points: np.ndarray) -> np.ndarray:
    """World rotation about the points' centre that stands them flat on their base (see up_axis).

    Identity when the base is tilted beyond LEVEL_MAX_DEG, and a step is only kept when it makes the
    base flatter: a thin cylinder (a pen) has no base to stand on, and turning it only rolls it."""
    points = np.asarray(points, dtype=np.float64)
    center = points.mean(axis=0)
    rotation = np.eye(3)
    tilt = tilt_deg(up_axis(points))
    if tilt > LEVEL_MAX_DEG:
        return rotation
    for _ in range(LEVEL_STEPS):
        if tilt < LEVEL_DONE_DEG:
            break
        turned = (points - center) @ rotation.T
        candidate = rotation_between(up_axis(turned), [0.0, 0.0, 1.0]) @ rotation
        candidate_tilt = tilt_deg(up_axis((points - center) @ candidate.T))
        if candidate_tilt >= tilt:
            break
        rotation, tilt = candidate, candidate_tilt
    return rotation


def rotation_matrix(rotation_wxyz: np.ndarray) -> np.ndarray:
    w, x, y, z = rotation_wxyz
    return Rotation.from_quat([x, y, z, w]).as_matrix()


def mesh_in_camera(vertices_glb: np.ndarray, pose: ObjectPose) -> np.ndarray:
    """Canonical GLB vertices -> upright OpenCV camera (x right, y down, z forward), SAM 3D depth units."""
    canonical = pose.scale * (np.asarray(vertices_glb, dtype=np.float64) @ GLB_TO_SAM3D.T)
    pytorch3d = canonical @ rotation_matrix(pose.rotation_wxyz) + pose.translation
    return pytorch3d @ PYTORCH3D_TO_CV.T


def upright_cv_to_arkit(image: UprightImage) -> np.ndarray:
    """Rotation from the upright photo's OpenCV camera to the ARKit camera of the raw sensor image."""
    center = np.array([[image.image.width / 2, image.image.height / 2]])
    origin = image.to_sensor(center)[0]
    right = image.to_sensor(center + [[1.0, 0.0]])[0] - origin
    down = image.to_sensor(center + [[0.0, 1.0]])[0] - origin
    # Sensor pixels: u grows along camera +x, v along camera -y; ARKit cameras look down -z.
    x_axis = np.array([right[0], -right[1], 0.0])
    y_axis = np.array([down[0], -down[1], 0.0])
    return np.column_stack([x_axis / np.linalg.norm(x_axis), y_axis / np.linalg.norm(y_axis), [0.0, 0.0, -1.0]])


def camera_to_world(view: CameraView, frame: WorldFrame, image: UprightImage) -> np.ndarray:
    """4x4: upright OpenCV camera of a photo -> simulation world."""
    cv_to_arkit = np.eye(4)
    cv_to_arkit[:3, :3] = upright_cv_to_arkit(image)
    return frame.matrix @ view.camera_to_world @ cv_to_arkit


def _transform(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    return points @ matrix[:3, :3].T + matrix[:3, 3]


def depth_scale(mesh_cv: np.ndarray, points_cv: np.ndarray) -> float | None:
    """Median ratio of point depth to the nearest mesh depth on the same pixel ray."""
    mesh = mesh_cv[mesh_cv[:, 2] > 1e-6]
    points = points_cv[points_cv[:, 2] > 1e-6]
    if len(mesh) == 0 or len(points) < MIN_DEPTH_MATCHES:
        return None
    rays = np.floor(np.vstack([mesh[:, :2] / mesh[:, 2:], points[:, :2] / points[:, 2:]]) / DEPTH_BIN_RAD)
    _, ray_ids = np.unique(rays.astype(np.int64), axis=0, return_inverse=True)
    ray_ids = ray_ids.reshape(-1)
    mesh_rays, point_rays = ray_ids[: len(mesh)], ray_ids[len(mesh) :]
    nearest = np.full(ray_ids.max() + 1, np.inf)
    np.minimum.at(nearest, mesh_rays, mesh[:, 2])
    hit = np.isfinite(nearest[point_rays])
    if hit.sum() < MIN_DEPTH_MATCHES:
        return None
    return float(np.median(points[hit, 2] / nearest[point_rays[hit]]))


def place_mesh(
    vertices_glb: np.ndarray,
    faces: np.ndarray,
    pose: ObjectPose,
    image: UprightImage,
    view: CameraView,
    frame: WorldFrame,
    lidar_points_world: np.ndarray,
) -> Placement:
    """SAM 3D mesh -> world: levelled on its base, depth (and so size) taken from its LiDAR points."""
    to_world = camera_to_world(view, frame, image)
    rotation = to_world[:3, :3]
    mesh_cv = mesh_in_camera(vertices_glb, pose)
    center = mesh_cv.mean(axis=0)
    level_deg = tilt_deg(up_axis(mesh_cv @ rotation.T))
    level = rotation.T @ level_rotation(mesh_cv @ rotation.T) @ rotation  # the same turn in camera axes
    mesh_cv = (mesh_cv - center) @ level.T + center
    level_deg -= tilt_deg(up_axis(mesh_cv @ rotation.T))
    lidar_world = np.asarray(lidar_points_world, dtype=np.float64)
    k = depth_scale(mesh_cv, _transform(np.linalg.inv(to_world), lidar_world))
    if k is None:
        raise ValueError("the object's LiDAR points do not overlap its mesh in the photo")
    world = _transform(to_world, mesh_cv * k)
    fit = float(surface_distances(world, faces, lidar_world).mean())
    return Placement(vertices_world=world, depth_scale=k, fit_error_m=fit, level_deg=level_deg)
