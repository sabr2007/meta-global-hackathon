import numpy as np
from PIL import Image

from scan2sim.capture import CameraView
from scan2sim.frames import WorldFrame
from scan2sim.hero import GL_TO_CV, PhotoCamera, decode_rle, encode_rle, upright_camera
from scan2sim.images import UprightImage
from scan2sim.segmentation import ObjectMask


def _sensor_projection(view: CameraView, points_arkit: np.ndarray) -> np.ndarray:
    local = (points_arkit - view.camera_to_world[:3, 3]) @ view.camera_to_world[:3, :3]
    cv = local @ GL_TO_CV
    k = view.intrinsics
    return np.column_stack([k[0, 0] * cv[:, 0] / cv[:, 2] + k[0, 2], k[1, 1] * cv[:, 1] / cv[:, 2] + k[1, 2]])


def test_upright_camera_matches_rotated_sensor_pixels():
    angle = np.deg2rad(25)
    rotation = np.array([[1, 0, 0], [0, np.cos(angle), -np.sin(angle)], [0, np.sin(angle), np.cos(angle)]])
    pose = np.eye(4)
    pose[:3, :3] = rotation
    pose[:3, 3] = [0.3, 1.4, -0.2]
    intrinsics = np.array([[1400.0, 0, 951.0], [0, 1390.0, 722.0], [0, 0, 1]])
    view = CameraView(image=None, width=1920, height=1440, intrinsics=intrinsics, camera_to_world=pose, timestamp=0.0)
    frame = WorldFrame(origin_arkit=np.array([0.5, 0.0, -1.0]))
    for turns, scale in ((1, 1.0), (0, 0.5), (3, 0.75)):
        size = (1440, 1920) if turns % 2 else (1920, 1440)
        image = UprightImage(Image.new("RGB", (round(size[0] * scale), round(size[1] * scale))), (1920, 1440), turns, scale)
        camera = upright_camera(view, image, frame)
        rng = np.random.default_rng(turns)
        points = pose[:3, 3] + (rng.uniform(-0.3, 0.3, (20, 3)) + [0, 0, -1.0]) @ rotation.T
        expected = image.from_sensor(_sensor_projection(view, points))
        pixels, depth = camera.project(frame.points(points))
        assert np.all(depth > 0)
        assert np.allclose(pixels, expected, atol=1e-6)


def test_rle_round_trip():
    raster = np.zeros((4, 5), dtype=bool)
    raster[1:3, 2:5] = True
    raster[0, 0] = True
    rle = encode_rle(ObjectMask("x", "1", (0, 0, 5, 4), None, (7, 9), raster))
    assert (rle["x"], rle["y"], rle["w"], rle["h"]) == (7, 9, 5, 4)
    assert rle["counts"][0] == 0  # first pixel is set, so the leading run of 0s is empty
    flat = np.zeros(20, dtype=bool)
    position, value = 0, False
    for count in rle["counts"]:
        flat[position : position + count] = value
        position += count
        value = not value
    assert np.array_equal(flat.reshape(4, 5), raster)


def test_decode_rle_inverts_encode_rle():
    rng = np.random.default_rng(5)
    raster = rng.random((13, 17)) > 0.6
    rle = encode_rle(ObjectMask("x", "1", (0, 0, 17, 13), None, (3, 4), raster))
    assert np.array_equal(decode_rle(rle), raster)


def test_seen_needs_the_frame_and_a_clear_line_of_sight():
    camera = PhotoCamera(100, 100, 100.0, 100.0, 50.0, 50.0, np.eye(4))  # at the origin, looking down -Z
    wall = np.array([[x, y, -1.0] for x in np.linspace(-0.2, 0.2, 60) for y in np.linspace(-0.2, 0.2, 60)])
    points = np.array([[0.0, 0.0, -1.0], [0.0, 0.0, -1.5], [3.0, 0.0, -1.0], [0.0, 0.0, 1.0]])
    assert camera.seen(points, wall).tolist() == [True, False, False, False]
