import io

import numpy as np
import pytest
from PIL import Image

from scan2sim.images import UprightImage
from scan2sim.reconstruct import mask_png, mesh_urls, parse_pose, request_arguments
from scan2sim.segmentation import ObjectMask


def _image(width=40, height=30) -> UprightImage:
    return UprightImage(image=Image.new("RGB", (width, height)), sensor_size=(width, height), clockwise_turns=0, scale=1.0)


def test_parse_pose_unwraps_fal_nesting_and_keeps_wxyz_order():
    pose = parse_pose(
        {
            "object_index": 0,
            "rotation": [[0.0, 0.0, 0.0, 2.0]],
            "translation": [[-0.5, 0.2, 1.3]],
            "scale": [[0.12, 0.12, 0.12]],
        }
    )
    assert pose.rotation_wxyz == pytest.approx([0.0, 0.0, 0.0, 1.0])  # normalised, order untouched
    assert pose.translation == pytest.approx([-0.5, 0.2, 1.3])
    assert pose.scale == pytest.approx(0.12)


def test_parse_pose_rejects_non_uniform_scale():
    with pytest.raises(ValueError):
        parse_pose({"rotation": [[1, 0, 0, 0]], "translation": [[0, 0, 1]], "scale": [[0.1, 0.2, 0.1]]})


def test_mask_png_is_single_channel_white_on_black_in_full_frame():
    mask = ObjectMask(
        concept="cup", object_id="1", box=(10, 5, 13, 7), confidence=0.9,
        mask_origin=(10, 5), mask=np.ones((2, 3), dtype=bool),
    )
    decoded = Image.open(io.BytesIO(mask_png(_image(), mask)))
    pixels = np.asarray(decoded)
    assert decoded.mode == "L" and decoded.size == (40, 30)
    assert pixels[5:7, 10:13].min() == 255
    assert pixels.sum() == 255 * 6


def test_request_selects_objects_by_mask_not_by_the_default_prompt():
    args = request_arguments("img", ["m0", "m1"], seed=7)
    assert args == {"image_url": "img", "mask_urls": ["m0", "m1"], "prompt": None, "seed": 7}


def test_mesh_urls_single_object_uses_model_glb():
    assert mesh_urls({"model_glb": {"url": "scene"}, "individual_glbs": None}, 1) == ["scene"]


def test_mesh_urls_keeps_missing_objects_as_none():
    result = {"individual_glbs": [{"url": "a"}, None, {"url": "c"}]}
    assert mesh_urls(result, 3) == ["a", None, "c"]


def test_mesh_urls_rejects_a_count_mismatch():
    with pytest.raises(RuntimeError):
        mesh_urls({"individual_glbs": [{"url": "a"}]}, 2)
