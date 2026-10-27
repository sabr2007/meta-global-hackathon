import numpy as np
import pytest
from PIL import Image
from scipy.spatial.transform import Rotation

from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.images import UprightImage
from scan2sim.placement import (
    DEPTH_BIN_RAD,
    camera_to_world,
    depth_scale,
    mesh_in_camera,
    place_mesh,
    upright_cv_to_arkit,
)
from scan2sim.reconstruct import ObjectPose

SENSOR = (64, 48)
IDENTITY = ObjectPose(rotation_wxyz=np.array([1.0, 0.0, 0.0, 0.0]), translation=np.zeros(3), scale=1.0)


def _upright(turns: int) -> UprightImage:
    w, h = SENSOR if turns % 2 == 0 else SENSOR[::-1]
    return UprightImage(image=Image.new("RGB", (w, h)), sensor_size=SENSOR, clockwise_turns=turns, scale=1.0)


def _box_vertices(n=12) -> np.ndarray:
    """Dense points on the surface of a 1 x 0.4 x 0.6 box in the GLB frame."""
    g = np.linspace(-0.5, 0.5, n)
    faces = []
    for axis in range(3):
        for side in (-0.5, 0.5):
            u, v = np.meshgrid(g, g)
            p = np.zeros((u.size, 3))
            p[:, axis] = side
            p[:, (axis + 1) % 3], p[:, (axis + 2) % 3] = u.ravel(), v.ravel()
            faces.append(p)
    return np.vstack(faces) * np.array([1.0, 0.4, 0.6])


def _nearest_per_ray(points_cv: np.ndarray) -> np.ndarray:
    """What a depth sensor at the camera centre sees: the closest point on every ray."""
    rays = np.floor(points_cv[:, :2] / points_cv[:, 2:] / DEPTH_BIN_RAD).astype(np.int64)
    order = np.lexsort((points_cv[:, 2], rays[:, 1], rays[:, 0]))
    first = np.r_[True, np.any(np.diff(rays[order], axis=0) != 0, axis=1)]
    return points_cv[order][first]


def test_upright_camera_of_an_unrotated_photo_is_arkit_with_y_and_z_flipped():
    assert upright_cv_to_arkit(_upright(0)) == pytest.approx(np.diag([1.0, -1.0, -1.0]))


def test_upright_camera_of_a_portrait_photo_swaps_x_and_y():
    # EXIF orientation 6: right in the upright photo is up on the sensor, down is sensor right.
    assert upright_cv_to_arkit(_upright(1)) == pytest.approx(np.array([[0, 1, 0], [1, 0, 0], [0, 0, -1.0]]))


@pytest.mark.parametrize("turns", [0, 1, 2, 3])
def test_upright_camera_is_a_proper_rotation_looking_down_arkit_minus_z(turns):
    m = upright_cv_to_arkit(_upright(turns))
    assert m.T @ m == pytest.approx(np.eye(3))
    assert np.linalg.det(m) == pytest.approx(1.0)
    assert m @ [0, 0, 1] == pytest.approx([0, 0, -1])


def test_mesh_in_camera_pins_the_measured_conventions():
    # glTF up (+Y) is SAM 3D's +Z; with an identity pose that is the camera's forward axis.
    assert mesh_in_camera(np.array([[0.0, 1.0, 0.0]]), IDENTITY)[0] == pytest.approx([0, 0, 1])
    # PyTorch3D +X points left, i.e. -x in the OpenCV camera.
    assert mesh_in_camera(np.array([[1.0, 0.0, 0.0]]), IDENTITY)[0] == pytest.approx([-1, 0, 0])
    # The quaternion is (w, x, y, z) and acts on row vectors: p @ R.
    quarter = Rotation.from_euler("z", 90, degrees=True)
    x, y, z, w = quarter.as_quat()
    pose = ObjectPose(rotation_wxyz=np.array([w, x, y, z]), translation=np.zeros(3), scale=1.0)
    expected = np.array([[1.0, 0.0, 0.0]]) @ quarter.as_matrix()
    assert mesh_in_camera(np.array([[1.0, 0.0, 0.0]]), pose)[0] == pytest.approx(expected[0] * [-1, -1, 1])


def test_depth_scale_recovers_a_uniform_depth_error():
    mesh = _box_vertices() * 0.3 + np.array([0.1, -0.05, 2.0])
    seen = _nearest_per_ray(mesh) * 0.85
    assert depth_scale(mesh, seen) == pytest.approx(0.85, abs=0.01)


def test_depth_scale_needs_overlapping_rays():
    mesh = _box_vertices() * 0.1 + np.array([0.0, 0.0, 2.0])
    elsewhere = mesh + np.array([1.5, 0.0, 0.0])
    assert depth_scale(mesh, elsewhere) is None


def test_place_mesh_puts_the_object_where_the_lidar_saw_it():
    image = _upright(1)
    camera = np.eye(4)
    camera[:3, :3] = Rotation.from_euler("yx", [30, -25], degrees=True).as_matrix()
    camera[:3, 3] = [0.3, 0.1, 0.5]
    view = CameraView(image=None, width=SENSOR[0], height=SENSOR[1], intrinsics=np.eye(3), camera_to_world=camera, timestamp=0.0)
    frame = WorldFrame(origin_arkit=np.array([0.0, -1.2, 0.0]))
    x, y, z, w = Rotation.from_euler("xyz", [20, -40, 70], degrees=True).as_quat()
    pose = ObjectPose(rotation_wxyz=np.array([w, x, y, z]), translation=np.array([0.2, -0.1, 1.4]), scale=0.25)
    vertices = _box_vertices()
    true_k = 0.86
    truth_cv = mesh_in_camera(vertices, pose) * true_k
    to_world = camera_to_world(view, frame, image)
    lidar_world = _nearest_per_ray(truth_cv) @ to_world[:3, :3].T + to_world[:3, 3]

    placed = place_mesh(vertices, pose, image, view, frame, lidar_world)

    assert placed.depth_scale == pytest.approx(true_k, abs=0.005)
    truth_world = truth_cv @ to_world[:3, :3].T + to_world[:3, 3]
    assert placed.vertices_world == pytest.approx(truth_world, abs=0.005)
    assert placed.fit_error_m < 0.01
