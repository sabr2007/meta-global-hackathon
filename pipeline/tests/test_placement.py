import numpy as np
import pytest
import trimesh
from PIL import Image
from scipy.spatial.transform import Rotation

from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.hero import silhouette, upright_camera
from scan2sim.images import UprightImage
from scan2sim.object_mesh import oriented_size, tilt_deg, up_axis
from scan2sim.placement import (
    DEPTH_BIN_RAD,
    GLB_TO_SAM3D,
    LEVEL_MAX_DEG,
    PYTORCH3D_TO_CV,
    camera_to_world,
    depth_scale,
    level_rotation,
    mesh_in_camera,
    place_mesh,
    table_contact_scale,
    upright_cv_to_arkit,
)
from scan2sim.reconstruct import ObjectPose
from scan2sim.segmentation import ObjectMask

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


def _box_mesh() -> trimesh.Trimesh:
    """The same 1 x 0.4 x 0.6 box as a dense triangle mesh."""
    box = trimesh.creation.box(extents=[1.0, 0.4, 0.6])
    for _ in range(4):
        box = box.subdivide()
    return box


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
    box = _box_mesh()
    true_k = 0.86
    truth_cv = mesh_in_camera(box.vertices, pose) * true_k
    to_world = camera_to_world(view, frame, image)
    lidar_world = _nearest_per_ray(truth_cv) @ to_world[:3, :3].T + to_world[:3, 3]
    assert level_rotation(truth_cv @ to_world[:3, :3].T) == pytest.approx(np.eye(3))  # no base near the table

    placed = place_mesh(box.vertices, box.faces, pose, image, view, frame, lidar_world)

    assert placed.depth_scale == pytest.approx(true_k, abs=0.005)
    truth_world = truth_cv @ to_world[:3, :3].T + to_world[:3, 3]
    assert placed.vertices_world == pytest.approx(truth_world, abs=0.005)
    assert placed.fit_error_m < 0.01


def _tilted(mesh: trimesh.Trimesh, degrees: float, axis=(1.0, 0.3, 0.0)) -> np.ndarray:
    return mesh.vertices @ Rotation.from_rotvec(np.radians(degrees) * np.asarray(axis) / np.linalg.norm(axis)).as_matrix().T


def test_levelling_stands_a_slightly_tilted_box_on_its_base():
    points = _tilted(trimesh.creation.box(extents=[0.07, 0.05, 0.03]), 6.0)
    assert tilt_deg(up_axis(points)) == pytest.approx(6.0, abs=0.01)
    assert tilt_deg(up_axis(points @ level_rotation(points).T)) < 0.2


def test_levelling_leaves_a_steep_tilt_alone():
    points = _tilted(trimesh.creation.box(extents=[0.07, 0.05, 0.03]), LEVEL_MAX_DEG + 10)
    assert level_rotation(points) == pytest.approx(np.eye(3))


def test_levelling_never_makes_a_base_steeper():
    pen = trimesh.creation.cylinder(radius=0.006, height=0.12, sections=10)
    pen.apply_transform(trimesh.transformations.rotation_matrix(np.radians(90), [1.0, 0.0, 0.0]))
    points = _tilted(pen, 2.0, axis=(0.2, 1.0, 0.0))
    before = tilt_deg(up_axis(points))
    assert tilt_deg(up_axis(points @ level_rotation(points).T)) <= before + 1e-9


def test_place_mesh_levels_a_slightly_tilted_object():
    image = _upright(0)
    camera = np.eye(4)
    camera[:3, :3] = Rotation.from_euler("x", -50, degrees=True).as_matrix()  # ARKit is +Y up: looking down
    view = CameraView(image=None, width=SENSOR[0], height=SENSOR[1], intrinsics=np.eye(3), camera_to_world=camera, timestamp=0.0)
    frame = WorldFrame(origin_arkit=np.zeros(3))
    to_world = camera_to_world(view, frame, image)
    box = _box_mesh()
    box.apply_scale(0.1)
    world = _tilted(box, 5.0) + [0.0, 0.6, -0.4]  # a box 0.6 m ahead, resting 5 degrees off level
    cv = (world - to_world[:3, 3]) @ to_world[:3, :3]  # its vertices in the camera
    glb = cv @ PYTORCH3D_TO_CV @ GLB_TO_SAM3D  # inverse of mesh_in_camera with an identity pose
    lidar_world = _nearest_per_ray(cv) @ to_world[:3, :3].T + to_world[:3, 3]

    placed = place_mesh(glb, box.faces, IDENTITY, image, view, frame, lidar_world)

    assert placed.level_deg == pytest.approx(5.0, abs=0.2)
    assert tilt_deg(up_axis(placed.vertices_world)) < 0.2
    assert placed.depth_scale == pytest.approx(1.0, abs=0.02)


def _desk_camera() -> tuple[UprightImage, CameraView, WorldFrame]:
    """A 320 x 240 photo looking 50 degrees down at a desk."""
    sensor = (320, 240)
    image = UprightImage(Image.new("RGB", sensor), sensor, 0, 1.0)
    pose = np.eye(4)
    pose[:3, :3] = Rotation.from_euler("x", -50, degrees=True).as_matrix()
    intrinsics = np.array([[300.0, 0.0, 160.0], [0.0, 300.0, 120.0], [0.0, 0.0, 1.0]])
    return image, CameraView(None, *sensor, intrinsics, pose, 0.0), WorldFrame(origin_arkit=np.zeros(3))


def test_place_mesh_matches_an_oversized_shifted_mesh_to_its_photo_silhouette():
    image, view, frame = _desk_camera()
    to_world = camera_to_world(view, frame, image)
    box = _box_mesh()
    box.apply_scale(0.08)  # 8 x 3.2 x 4.8 cm
    truth = box.vertices + [0.02, 0.5, -0.45]
    truth_cv = (truth - to_world[:3, 3]) @ to_world[:3, :3]
    center = truth_cv.mean(axis=0)
    guess_cv = ((truth_cv - center) * 1.2 + center + [0.008, -0.004, 0.0]) * 1.15  # SAM 3D: too big, off, too far
    mask = ObjectMask("box", "1", (0, 0, 320, 240), None, (0, 0), silhouette(upright_camera(view, image, frame), truth, box.faces))
    lidar = _nearest_per_ray(truth_cv) @ to_world[:3, :3].T + to_world[:3, 3]

    unmatched = place_mesh(guess_cv @ PYTORCH3D_TO_CV @ GLB_TO_SAM3D, box.faces, IDENTITY, image, view, frame, lidar)
    placed = place_mesh(guess_cv @ PYTORCH3D_TO_CV @ GLB_TO_SAM3D, box.faces, IDENTITY, image, view, frame, lidar, mask)

    assert oriented_size(unmatched.vertices_world)[0] > 1.15 * 0.08  # the depth fit alone keeps it too big
    assert placed.photo_scale == pytest.approx(1 / 1.2, rel=0.02)
    assert oriented_size(placed.vertices_world) == pytest.approx(oriented_size(truth), rel=0.03)
    assert placed.vertices_world.mean(axis=0) == pytest.approx(truth.mean(axis=0), abs=0.003)
    assert placed.fit_error_m < unmatched.fit_error_m


TABLE_Z = -0.45  # the desk camera is 45 cm above the table
REST_Z = TABLE_Z + 0.003


def _bottle(image, view, frame, standing_on: float = TABLE_Z) -> tuple[trimesh.Trimesh, np.ndarray, np.ndarray]:
    """A 6 x 6 x 12 cm bottle standing at height `standing_on`: (mesh, world vertices, camera vertices)."""
    to_world = camera_to_world(view, frame, image)
    bottle = trimesh.creation.box(extents=[0.06, 0.06, 0.12])
    for _ in range(4):
        bottle = bottle.subdivide()
    world = bottle.vertices + [0.0, 0.5, standing_on + 0.06]
    return bottle, world, (world - to_world[:3, 3]) @ to_world[:3, :3]


def test_table_contact_scale_puts_the_lowest_point_on_the_table():
    image, view, frame = _desk_camera()
    to_world = camera_to_world(view, frame, image)
    _, _, cv = _bottle(image, view, frame, standing_on=TABLE_Z - 0.05)
    k = table_contact_scale(cv, to_world, TABLE_Z)
    assert (cv * k @ to_world[:3, :3].T + to_world[:3, 3])[:, 2].min() == pytest.approx(TABLE_Z)
    assert table_contact_scale(cv, to_world, 0.1) is None  # a table above the camera


def test_a_bottle_the_lidar_sees_through_rests_on_the_table():
    image, view, frame = _desk_camera()
    to_world = camera_to_world(view, frame, image)
    bottle, truth, truth_cv = _bottle(image, view, frame)
    seen = _nearest_per_ray(truth_cv) @ to_world[:3, :3].T  # rays from the camera centre through the bottle
    behind = seen * ((TABLE_Z - to_world[2, 3]) / seen[:, 2:]) + to_world[:3, 3]  # ...land on the table behind it

    placed = place_mesh(truth_cv @ PYTORCH3D_TO_CV @ GLB_TO_SAM3D, bottle.faces, IDENTITY, image, view, frame, behind, rest_z=REST_Z)
    lidar_only = place_mesh(truth_cv @ PYTORCH3D_TO_CV @ GLB_TO_SAM3D, bottle.faces, IDENTITY, image, view, frame, behind)

    assert lidar_only.vertices_world[:, 2].min() < TABLE_Z - 0.05  # LiDAR alone sinks it into the table
    assert placed.depth_source == "table"
    assert placed.vertices_world[:, 2].min() == pytest.approx(REST_Z)
    assert placed.vertices_world == pytest.approx(truth, abs=0.006)


def test_an_object_the_lidar_sees_keeps_the_lidar_depth():
    image, view, frame = _desk_camera()
    to_world = camera_to_world(view, frame, image)
    bottle, truth, truth_cv = _bottle(image, view, frame, standing_on=TABLE_Z + 0.01)  # on a book
    lidar = _nearest_per_ray(truth_cv) @ to_world[:3, :3].T + to_world[:3, 3]

    placed = place_mesh(truth_cv @ PYTORCH3D_TO_CV @ GLB_TO_SAM3D, bottle.faces, IDENTITY, image, view, frame, lidar, rest_z=REST_Z)

    assert placed.depth_source == "lidar"
    assert placed.vertices_world == pytest.approx(truth, abs=0.002)
