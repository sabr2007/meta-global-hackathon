import numpy as np
import trimesh

from fixtures import look_at
from scan2sim.bake import bake_photo_colors
from scan2sim.color import delta_e, srgb_to_lab
from scan2sim.hero import PhotoCamera, silhouette

ORANGE, RED, GREEN = (230, 120, 30), (200, 35, 30), (40, 200, 60)
SIZE = 480


def _red_box_seen_from_above() -> tuple[trimesh.Trimesh, PhotoCamera]:
    """A red 8 x 6 x 4 cm box (dense vertices) and a camera looking down at it at 45 degrees."""
    box = trimesh.creation.box(extents=[0.08, 0.06, 0.04])
    for _ in range(3):
        box = box.subdivide()
    box.visual.vertex_colors = np.tile([*RED, 255], (len(box.vertices), 1))
    return box, PhotoCamera(SIZE, SIZE, 600.0, 600.0, SIZE / 2, SIZE / 2, look_at([0.0, -0.35, 0.35], [0.0, 0.0, 0.0]))


def _distance(colors: np.ndarray, rgb) -> np.ndarray:
    return delta_e(srgb_to_lab(colors[:, :3]), srgb_to_lab(np.asarray(rgb)))


def test_the_photographed_side_takes_the_photo_colour_and_the_hidden_side_follows():
    box, camera = _red_box_seen_from_above()
    mask = silhouette(camera, box.vertices, box.faces)
    photo = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    photo[mask] = ORANGE

    baked = bake_photo_colors(box, camera, photo, mask)

    top = np.isclose(box.vertices[:, 2], 0.02)
    bottom = np.isclose(box.vertices[:, 2], -0.02)
    inner_top = top & (np.abs(box.vertices[:, 0]) < 0.03) & (np.abs(box.vertices[:, 1]) < 0.02)
    assert _distance(baked[inner_top], ORANGE).max() < 2.0  # seen head-on: the photo's colour
    assert _distance(baked[bottom], ORANGE).max() < 2.0  # hidden: SAM 3D's red, matched to the photo
    assert _distance(baked[bottom], RED).min() > 20.0


def test_photo_pixels_outside_the_mask_never_colour_the_mesh():
    box, camera = _red_box_seen_from_above()
    mask = silhouette(camera, box.vertices, box.faces).copy()
    mask[:, SIZE // 2 :] = False  # something else covers the right half of the object
    photo = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    photo[:] = GREEN
    photo[mask] = ORANGE

    baked = bake_photo_colors(box, camera, photo, mask)

    assert _distance(baked, GREEN).min() > 30.0
    assert baked[:, 3].min() == 255


def test_without_a_photographed_vertex_the_colours_stay():
    box, camera = _red_box_seen_from_above()
    nothing = np.zeros((SIZE, SIZE), dtype=bool)
    baked = bake_photo_colors(box, camera, np.zeros((SIZE, SIZE, 3), dtype=np.uint8), nothing)
    assert np.array_equal(baked[:, :3], np.asarray(box.visual.vertex_colors)[:, :3])
