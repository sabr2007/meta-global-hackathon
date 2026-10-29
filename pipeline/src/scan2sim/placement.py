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

Before the depth is fitted, two corrections from the photo itself:
- level: SAM 3D poses come out 1-13 degrees off the table (the mouse on our desk 12.9), and a tilted
  mesh rocks onto its base in the first steps of the simulation. The mesh turns about its centre
  until the collider face below its centre of mass, the face it would settle on, is flat;
- silhouette: seen through the phone's camera, SAM 3D meshes cover 10-40% more pixels than their
  SAM 3.1 masks and sit 10-35 px off (SAM 3D lays objects out in MoGe's estimated camera, not the
  phone's), so after the depth fit small objects came out 15-25% too large. The mesh is scaled about
  its centre and moved across the image until its silhouette has the mask's area and centroid.

After it, one from the table: LiDAR sees through glass and clear plastic (a perfume bottle's points
lie on the table behind it) and smooths small objects into the table, so its depth can put a mesh
inside the table it stands on. Such a mesh slides back along its camera rays until it rests on the
table, which leaves the photo's view of it unchanged. Only a mesh the LiDAR fits clearly better where
it was (a laptop on a tray) keeps the LiDAR depth and is lifted out of the table instead.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial.transform import Rotation

from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.hero import PhotoCamera, full_raster, silhouette, upright_camera
from scan2sim.images import UprightImage
from scan2sim.object_mesh import surface_distances, tilt_deg, up_axis
from scan2sim.reconstruct import ObjectPose
from scan2sim.segmentation import ObjectMask

GLB_TO_SAM3D = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
PYTORCH3D_TO_CV = np.diag([-1.0, -1.0, 1.0])  # both look along +z; flip x left -> right, y up -> down
DEPTH_BIN_RAD = 0.004  # about 4 px at the photo's focal length
MIN_DEPTH_MATCHES = 20
LEVEL_MAX_DEG = 45.0  # a pen rolls up to ~45 degrees onto its flattest side; a mesh turned further is not a pose error
LEVEL_DONE_DEG = 0.2
LEVEL_STEPS = 6  # rolling onto the next face below the centre of mass; six steps settle every object we scanned
SILHOUETTE_STEPS = 2  # the second step absorbs perspective; a third changes nothing we can measure
MAX_PHOTO_SCALE = 1.25  # a partly hidden mask must not shrink (or grow) a mesh by more than this
SEE_THROUGH_M = 0.02  # LiDAR depth this deep inside the table means it saw past the object
SLIDE_FIT_TOLERANCE_M = 0.003  # keep the LiDAR depth only when it fits the points this much better


@dataclass(frozen=True)
class Placement:
    vertices_world: np.ndarray  # (N, 3) mesh vertices in the simulation world
    depth_scale: float  # metric depth / SAM 3D depth
    fit_error_m: float  # mean distance from the object's LiDAR points to the placed mesh surface
    level_deg: float = 0.0  # tilt of the SAM 3D pose that levelling removed
    photo_scale: float = 1.0  # size correction from the photo silhouette
    depth_source: str = "lidar"  # "lidar", or "table" when the mesh was slid back to rest on it


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The smallest rotation that turns direction a into direction b."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    axis = np.cross(a / np.linalg.norm(a), b / np.linalg.norm(b))
    sine, cosine = np.linalg.norm(axis), float(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b))
    if sine < 1e-12:
        return np.eye(3)
    return Rotation.from_rotvec(axis / sine * np.arctan2(sine, cosine)).as_matrix()


def level_rotation(points: np.ndarray) -> np.ndarray:
    """World rotation that sets the points down on the face they come to rest on (see up_axis).

    Each step turns the face below the centre of mass flat, which can bring another face below it
    (a pen rolls, a spoon tips onto its bowl): a few steps follow that roll to a face the mesh stays
    on. Identity when the roll would exceed LEVEL_MAX_DEG (not a pose error) or ends no flatter."""
    points = np.asarray(points, dtype=np.float64) - np.mean(points, axis=0)
    start = tilt_deg(up_axis(points))
    rotation = np.eye(3)
    for _ in range(LEVEL_STEPS):
        up = up_axis(points @ rotation.T)
        if tilt_deg(up) < LEVEL_DONE_DEG:
            break
        rotation = rotation_between(up, [0.0, 0.0, 1.0]) @ rotation
    turned_deg = np.degrees(np.arccos(np.clip((np.trace(rotation) - 1) / 2, -1.0, 1.0)))
    if turned_deg > LEVEL_MAX_DEG or tilt_deg(up_axis(points @ rotation.T)) >= start:
        return np.eye(3)
    return rotation


def _centroid(raster: np.ndarray) -> np.ndarray:
    return np.argwhere(raster).mean(axis=0)[::-1]


def silhouette_correction(
    mesh_cv: np.ndarray, faces: np.ndarray, camera: PhotoCamera, cv_to_world: np.ndarray, mask: ObjectMask
) -> tuple[float, np.ndarray]:
    """Scale about the mesh centre and camera-frame shift that give the mesh's silhouette in the photo
    the area and centroid of its mask (to first order: perspective is left to a second step)."""
    rendered = silhouette(camera, _transform(cv_to_world, mesh_cv), faces)
    observed = full_raster(mask, (camera.width, camera.height))
    if not rendered.any() or not observed.any():
        return 1.0, np.zeros(3)
    scale = float(np.sqrt(observed.sum() / rendered.sum()))
    center = mesh_cv.mean(axis=0)
    focal, principal = np.array([camera.fx, camera.fy]), np.array([camera.cx, camera.cy])
    center_px = focal * center[:2] / center[2] + principal
    scaled_px = center_px + scale * (_centroid(rendered) - center_px)  # where the centroid goes when scaled
    ray = lambda px: np.array([*((px - principal) / focal), 1.0])  # noqa: E731
    return scale, center[2] * (ray(_centroid(observed)) - ray(scaled_px))


def table_contact_scale(mesh_cv: np.ndarray, cv_to_world: np.ndarray, rest_z: float) -> float | None:
    """Depth scale at which the mesh's lowest point is at height rest_z (None if the camera is not above it)."""
    lowest = float((mesh_cv @ cv_to_world[:3, :3].T)[:, 2].min())
    drop = rest_z - cv_to_world[2, 3]
    return drop / lowest if lowest < 0 and drop < 0 else None


def choose_depth(
    mesh_cv: np.ndarray, faces: np.ndarray, cv_to_world: np.ndarray, k_lidar: float, lidar_world: np.ndarray, rest_z: float
) -> tuple[float, str]:
    """The LiDAR depth scale, or the table contact one when the LiDAR depth puts the mesh inside the table."""
    k_table = table_contact_scale(mesh_cv, cv_to_world, rest_z)
    if k_table is None or k_lidar <= k_table:
        return k_lidar, "lidar"
    lidar_placed = _transform(cv_to_world, mesh_cv * k_lidar)
    depth_inside = rest_z - float(lidar_placed[:, 2].min())
    if depth_inside > SEE_THROUGH_M:
        return k_table, "table"
    fit = lambda world: float(surface_distances(world, faces, lidar_world).mean())  # noqa: E731
    lifted = fit(lidar_placed + [0.0, 0.0, depth_inside])
    slid = fit(_transform(cv_to_world, mesh_cv * k_table))
    return (k_table, "table") if slid <= lifted + SLIDE_FIT_TOLERANCE_M else (k_lidar, "lidar")


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
    mask: ObjectMask | None = None,
    rest_z: float | None = None,
) -> Placement:
    """SAM 3D mesh -> world: levelled on its base, matched to its photo silhouette when the mask is
    given, depth (and so metric size) taken from its LiDAR points, or from resting on the table
    whose top is at rest_z when the LiDAR depth puts it inside."""
    to_world = camera_to_world(view, frame, image)
    rotation = to_world[:3, :3]
    mesh_cv = mesh_in_camera(vertices_glb, pose)
    center = mesh_cv.mean(axis=0)
    level_deg = tilt_deg(up_axis(mesh_cv @ rotation.T))
    level = rotation.T @ level_rotation(mesh_cv @ rotation.T) @ rotation  # the same turn in camera axes
    mesh_cv = (mesh_cv - center) @ level.T + center
    level_deg -= tilt_deg(up_axis(mesh_cv @ rotation.T))
    photo_scale = 1.0
    if mask is not None:
        camera = upright_camera(view, image, frame)
        for _ in range(SILHOUETTE_STEPS):
            scale, shift = silhouette_correction(mesh_cv, faces, camera, to_world, mask)
            scale = float(np.clip(photo_scale * scale, 1 / MAX_PHOTO_SCALE, MAX_PHOTO_SCALE)) / photo_scale
            center = mesh_cv.mean(axis=0)
            mesh_cv = (mesh_cv - center) * scale + center + shift
            photo_scale *= scale
    lidar_world = np.asarray(lidar_points_world, dtype=np.float64)
    k = depth_scale(mesh_cv, _transform(np.linalg.inv(to_world), lidar_world))
    if k is None:
        raise ValueError("the object's LiDAR points do not overlap its mesh in the photo")
    source = "lidar"
    if rest_z is not None:
        k, source = choose_depth(mesh_cv, faces, to_world, k, lidar_world, rest_z)
    world = _transform(to_world, mesh_cv * k)
    fit = float(surface_distances(world, faces, lidar_world).mean())
    return Placement(world, k, fit, level_deg, photo_scale, source)
