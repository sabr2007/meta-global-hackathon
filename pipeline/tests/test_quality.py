import dataclasses
import json

import numpy as np
import pytest
import trimesh
from PIL import Image

from fixtures import CUP_RGB, DROP_GAP, cup_on_table, look_at, ring_on_table, room_document
from scan2sim.cli import main
from scan2sim.color import lab_to_srgb, srgb_to_lab
from scan2sim.export import _object_metadata
from scan2sim.hero import MASKS_FILE, PhotoCamera, encode_rle, silhouette
from scan2sim.mjcf import scene_to_mjcf
from scan2sim.object_mesh import surface_distances, surface_samples, tilt_deg, up_axis
from scan2sim.quality import collider_meshes, hole_open, mean_color_difference, report, robust_extents, settle_drift, start_state, view_axes
from scan2sim.roomplan import parse_room
from scan2sim.scene import build_scene
from scan2sim.segmentation import ObjectMask

SIZE = 240


@pytest.fixture
def scene():
    return build_scene(parse_room(room_document()), probe_count=0)


def _camera(target) -> PhotoCamera:
    """A 240 px camera 0.5 m from the target, looking down at it at 45 degrees."""
    pose = look_at(np.asarray(target) + [0.0, -0.35, 0.35], target)
    return PhotoCamera(SIZE, SIZE, 300.0, 300.0, SIZE / 2, SIZE / 2, pose)


def _box(extents=(0.1, 0.06, 0.03), center=(0.0, 0.0, 0.0)) -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=extents)
    box.apply_translation(center)
    return box


def test_surface_distances_are_exact():
    box = _box(extents=(0.1, 0.1, 0.1))
    points = np.array([[0.05 + 0.02, 0.0, 0.0], [0.0, 0.0, 0.05 + 0.003], [0.04, 0.0, 0.0], [0.08, 0.08, 0.05]])
    expected = [0.02, 0.003, 0.01, np.hypot(0.03, 0.03)]
    assert surface_distances(box.vertices, box.faces, points) == pytest.approx(expected, abs=1e-9)


def test_tilt_is_the_angle_of_the_base_off_the_table():
    box = _box()
    assert tilt_deg(up_axis(box.vertices)) == pytest.approx(0.0, abs=1e-6)
    box.apply_transform(trimesh.transformations.rotation_matrix(np.radians(7.0), [1.0, 0.4, 0.0]))
    assert tilt_deg(up_axis(box.vertices)) == pytest.approx(7.0, abs=0.01)


def test_a_round_object_has_no_tilt_to_fix():
    sphere = trimesh.creation.icosphere(subdivisions=4, radius=0.04)
    sphere.apply_transform(trimesh.transformations.rotation_matrix(np.radians(25.0), [1.0, 0.0, 0.0]))
    assert tilt_deg(up_axis(sphere.vertices)) < 1.0


def test_the_photo_does_not_see_the_far_side_of_a_box():
    box = _box()
    camera = _camera([0.0, 0.0, 0.0])
    near_top = [0.0, -0.01, 0.015]  # top face, facing the camera
    under = [0.0, 0.0, -0.015]  # bottom face
    seen = camera.seen(np.array([near_top, under]), surface_samples(box))
    assert seen.tolist() == [True, False]


def test_a_mesh_matching_its_scan_has_size_ratio_one_and_a_bigger_mesh_shows_it():
    box = _box(center=(0.0, 0.0, 0.015))
    camera = _camera([0.0, 0.0, 0.015])
    samples = surface_samples(box)
    lidar = samples[camera.seen(samples, samples)]
    for scale in (1.0, 1.15):
        mesh = box.copy()
        mesh.apply_scale(scale)
        mesh.apply_translation([0.0, 0.0, -mesh.vertices[:, 2].min()])
        surface = surface_samples(mesh)
        seen = surface[camera.seen(surface, surface)]
        axes = view_axes(camera, [0.0, 0.0, 0.0])
        ratio = robust_extents(seen, axes, 0.0) / robust_extents(lidar, axes, 0.0)
        assert ratio == pytest.approx([scale] * 3, rel=0.03)


def test_view_axes_run_across_and_along_the_line_of_sight():
    camera = _camera([0.0, 0.0, 0.0])  # looks along +y
    assert view_axes(camera, [0.0, 0.0, 0.0]) == pytest.approx(np.array([[-1.0, 0.0], [0.0, 1.0]]))


def test_colour_difference_tells_orange_from_red():
    photo = np.zeros((10, 10, 3), dtype=np.uint8)
    photo[:] = CUP_RGB
    mask = np.ones((10, 10), dtype=bool)
    assert mean_color_difference(photo, mask, np.tile(CUP_RGB, (5, 1))) == pytest.approx(0.0, abs=1e-6)
    assert mean_color_difference(photo, mask, np.tile([200, 35, 30], (5, 1))) > 20


def test_settle_drift_of_an_object_dropped_onto_the_table(scene, tmp_path):
    mjcf = tmp_path / "scene.xml"
    mjcf.write_text(scene_to_mjcf(dataclasses.replace(scene, objects=(cup_on_table(scene),))))
    assert settle_drift(mjcf, ["obj_0_cup"])["obj_0_cup"] == pytest.approx(DROP_GAP, abs=1.5e-3)


def _bundle(tmp_path, scene, rgb) -> PhotoCamera:
    """A bundle as `scan2sim objects` writes it: one orange cup on the table, seen by the hero camera."""
    cup = cup_on_table(scene)
    camera = _camera(cup.position)
    mesh = trimesh.load(trimesh.util.wrap_as_stream(cup.visual_glb), file_type="glb", force="mesh")
    raster = silhouette(camera, mesh.vertices + cup.position, mesh.faces)
    photo = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
    photo[raster] = rgb
    Image.fromarray(photo).save(tmp_path / "hero.jpg", quality=95)
    (tmp_path / "objects").mkdir()
    (tmp_path / "objects" / f"{cup.name}.glb").write_bytes(cup.visual_glb)
    (tmp_path / "scene.xml").write_text(scene_to_mjcf(dataclasses.replace(scene, objects=(cup,))))
    mask = ObjectMask("orange cup", "1", (0, 0, SIZE, SIZE), None, (0, 0), raster)
    entry = {"object": cup.name, "concept": "orange cup", "box": [0, 0, SIZE, SIZE], "area_px": mask.area_px, "rle": encode_rle(mask)}
    (tmp_path / MASKS_FILE).write_text(json.dumps({"width": SIZE, "height": SIZE, "masks": [entry]}))
    meta = {
        "objects": [_object_metadata(cup)],
        "camera": {**camera.metadata(), "alignment": {cup.name: {"iou": 0.9, "centroid_offset_px": 1.0}}},
        "frame": {"arkit_to_world": scene.frame.matrix.tolist()},
        "files": {"mjcf": "scene.xml", "mesh": "room_mesh.glb"},
    }
    (tmp_path / "scene.json").write_text(json.dumps(meta))
    return camera


def test_report_grades_every_object_of_a_bundle(scene, tmp_path):
    _bundle(tmp_path, scene, CUP_RGB)
    (row,) = report(tmp_path)
    assert row.name == "obj_0_cup" and row.label == "cup"
    assert row.tilt_deg == pytest.approx(0.0, abs=0.1)
    assert row.drift_cm == pytest.approx(DROP_GAP * 100, abs=0.15)
    assert row.color_de < 3.0
    assert row.iou == 0.9
    assert row.lidar_mm is None and row.size is None  # no capture given
    assert row.depth == "lidar"
    assert row.mass_g == pytest.approx(600 * 0.08 * 0.06 * 0.10 * 1000, rel=1e-3)  # 600 kg/m^3 of its hull


def test_report_command_prints_the_table_and_writes_json(scene, tmp_path, capsys):
    _bundle(tmp_path, scene, (200, 35, 30))
    out = tmp_path / "report.json"
    assert main(["report", str(tmp_path), "--json", str(out)]) == 0
    printed = capsys.readouterr().out
    assert "cup" in printed and "median" in printed
    (row,) = json.loads(out.read_text())
    assert row["color_de"] > 20  # the photo shows a red cup, the mesh is orange


def test_lab_round_trips_to_srgb():
    rgb = np.array([[230, 120, 30], [200, 35, 30], [40, 200, 60], [250, 250, 250], [5, 5, 5]], dtype=np.float64)
    assert lab_to_srgb(srgb_to_lab(rgb)) == pytest.approx(rgb, abs=1e-6)


@pytest.mark.parametrize("decomposed", [False, True])
def test_hole_open_measures_how_much_of_a_ring_the_colliders_leave_open(scene, tmp_path, decomposed):
    ring = ring_on_table(scene, decomposed)
    mjcf = tmp_path / "scene.xml"
    mjcf.write_text(scene_to_mjcf(dataclasses.replace(scene, objects=(ring,))))
    colliders = collider_meshes(*start_state(mjcf), ring.name)
    mesh = trimesh.load(trimesh.util.wrap_as_stream(ring.visual_glb), file_type="glb", force="mesh")
    mesh.apply_translation(ring.position)
    opened = hole_open(mesh, colliders)
    assert opened > 0.9 if decomposed else opened == 0.0
    assert hole_open(_box(), [(_box().vertices, _box().faces)]) is None  # nothing to leave open
