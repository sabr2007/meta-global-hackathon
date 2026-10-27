import json

import numpy as np
import pytest
from PIL import Image

from scan2sim.capture import CameraView
from scan2sim.discovery import parse_discovery
from scan2sim.images import EXIF_ORIENTATION_TAG, load_upright
from scan2sim.views import project, views_of

SENSOR_W, SENSOR_H = 40, 30


def _sensor_photo(tmp_path, orientation: int, marker=(5, 7)):
    image = Image.new("RGB", (SENSOR_W, SENSOR_H), "black")
    image.putpixel(marker, (255, 255, 255))
    exif = Image.Exif()
    exif[EXIF_ORIENTATION_TAG] = orientation
    path = tmp_path / f"photo-{orientation}.jpg"
    image.save(path, quality=100, subsampling=0, exif=exif)
    return path


@pytest.mark.parametrize("orientation", [1, 3, 6, 8])
def test_upright_pixels_map_back_to_sensor_pixels(tmp_path, orientation):
    marker = (5, 7)
    upright = load_upright(_sensor_photo(tmp_path, orientation, marker))
    pixels = np.asarray(upright.image.convert("L"), dtype=np.int32)
    y, x = np.unravel_index(np.argmax(pixels), pixels.shape)
    # pixel centres: +0.5 in, round-trip, -0.5 out
    sensor = upright.to_sensor(np.array([[x + 0.5, y + 0.5]]))[0] - 0.5
    assert sensor == pytest.approx(marker, abs=1.0)


def test_parse_discovery_normalises_and_dedupes():
    payload = json.dumps(
        {
            "objects": [
                {"concept": " Orange  Ring ", "label": "ring", "graspable": True, "approx_longest_side_cm": 8, "count": 1},
                {"concept": "orange ring", "label": "dup", "graspable": True, "approx_longest_side_cm": 8, "count": 1},
                {"concept": "mug, cup", "label": "list", "graspable": True, "approx_longest_side_cm": 10, "count": 1},
                {"concept": "", "label": "empty", "graspable": False, "approx_longest_side_cm": 1, "count": 0},
            ]
        }
    )
    (obj,) = parse_discovery(payload)
    assert obj.concept == "orange ring"
    assert obj.count == 1


def _camera_at_origin_looking_down_minus_z() -> CameraView:
    intrinsics = np.array([[100.0, 0.0, 50.0], [0.0, 100.0, 40.0], [0.0, 0.0, 1.0]])
    return CameraView(image=None, width=100, height=80, intrinsics=intrinsics, camera_to_world=np.eye(4), timestamp=0.0)


def test_project_point_in_front_of_camera():
    pixel, depth = project(_camera_at_origin_looking_down_minus_z(), np.array([0.1, 0.2, -1.0]))
    assert depth == pytest.approx(1.0)
    assert pixel == pytest.approx([60.0, 20.0])  # +x right, +y up -> smaller row


def test_points_behind_the_camera_are_not_visible():
    view = _camera_at_origin_looking_down_minus_z()
    assert project(view, np.array([0.0, 0.0, 1.0])) is None
    assert views_of(np.array([0.0, 0.0, 1.0]), (view,)) == []
