import dataclasses
import json

import mujoco
import numpy as np
import pytest
import trimesh

from fixtures import TABLE_H, room_document
from scan2sim.export import _object_metadata
from scan2sim.mjcf import scene_to_mjcf
from scan2sim.object_mesh import HULL_MAX_VERTICES, convex_hull, oriented_size, simplify
from scan2sim.objects import body_name, rests_on, support_top, target_surface
from scan2sim.roomplan import parse_room
from scan2sim.scene import ScannedObject, build_scene

SETTLE_SECONDS = 2.0
CUP_SIZE = np.array([0.08, 0.06, 0.10])


@pytest.fixture
def scene():
    return build_scene(parse_room(room_document()), probe_count=0)


def _table(scene):
    (table,) = [b for b in scene.boxes if b.category == "table"]
    return table


def _cup(scene, name="obj_0_cup") -> ScannedObject:
    """A box-shaped 'scanned object' resting just above the table centre."""
    table = _table(scene)
    hull = trimesh.creation.box(extents=CUP_SIZE)
    return ScannedObject(
        name=name,
        label="cup",
        position=np.array([table.center[0], table.center[1], TABLE_H + CUP_SIZE[2] / 2 + 0.003]),
        visual_glb=hull.export(file_type="glb"),
        hull_vertices=np.asarray(hull.vertices),
        hull_faces=np.asarray(hull.faces),
        size=CUP_SIZE,
        rgba=(0.9, 0.5, 0.2, 1.0),
        depth_scale=0.86,
        fit_error_m=0.005,
    )


def test_body_names_are_mjcf_safe():
    assert body_name(3, "White Earbud-case!") == "obj_3_white_earbud_case"
    assert body_name(0, "???") == "obj_0_object"


def test_support_is_the_table_under_the_object(scene):
    table = _table(scene)
    assert support_top(scene.boxes, table.center[:2], TABLE_H - 0.01) == pytest.approx(TABLE_H)


def test_support_is_the_floor_away_from_furniture(scene):
    assert support_top(scene.boxes, np.array([-1.7, 1.2]), 0.0) == 0.0


def test_a_surface_far_above_the_object_is_not_its_support(scene):
    assert support_top(scene.boxes, _table(scene).center[:2], 0.2) == 0.0


def test_the_scanned_surface_is_the_largest_table_or_the_named_element(scene):
    table = _table(scene)
    assert target_surface(scene.boxes) is table
    assert target_surface(scene.boxes, table.name) is table
    assert target_surface(scene.boxes, "no_such_element") is None


def test_an_object_whose_points_start_just_below_the_roomplan_top_rests_on_the_table(scene):
    table = _table(scene)
    assert rests_on(table, table.center[:2], TABLE_H - 0.02)


def test_a_small_stack_on_the_table_still_rests_on_it(scene):
    table = _table(scene)
    assert rests_on(table, table.center[:2], TABLE_H + 0.03)


def test_an_object_on_a_shelf_over_the_table_does_not_rest_on_it(scene):
    table = _table(scene)
    assert not rests_on(table, table.center[:2], TABLE_H + 0.41)


def test_an_object_on_the_floor_beside_the_table_does_not_rest_on_it(scene):
    assert not rests_on(_table(scene), np.array([-1.7, 1.2]), TABLE_H)


def test_scanned_object_rests_on_the_table(scene):
    scene = dataclasses.replace(scene, objects=(_cup(scene),))
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(scene))
    data = mujoco.MjData(model)
    for _ in range(int(SETTLE_SECONDS / model.opt.timestep)):
        mujoco.mj_step(model, data)
    assert data.body("obj_0_cup").xpos[2] == pytest.approx(TABLE_H + CUP_SIZE[2] / 2, abs=3e-3)
    assert model.body("obj_0_cup").mass[0] > 0


def test_simplify_reduces_faces_and_keeps_colours():
    sphere = trimesh.creation.icosphere(subdivisions=5)
    colors = np.where(sphere.vertices[:, :1] < 0, [255, 0, 0, 255], [0, 0, 255, 255]).astype(np.uint8)
    mesh = trimesh.Trimesh(sphere.vertices, sphere.faces, vertex_colors=colors, process=False)
    light = simplify(mesh, target_faces=2000)
    assert len(light.faces) <= 2000
    left = np.asarray(light.visual.vertex_colors)[light.vertices[:, 0] < -0.2]
    assert (left[:, 0] == 255).all() and (left[:, 2] == 0).all()


def test_convex_hull_is_small_closed_and_convex():
    points = trimesh.creation.icosphere(subdivisions=5).vertices
    vertices, faces = convex_hull(points)
    hull = trimesh.Trimesh(vertices, faces)
    assert len(vertices) <= HULL_MAX_VERTICES
    assert hull.is_watertight and hull.is_convex
    assert hull.volume == pytest.approx(4 / 3 * np.pi, rel=0.1)


def test_oriented_size_ignores_rotation_in_the_ground_plane():
    box = trimesh.creation.box(extents=[0.3, 0.1, 0.02])
    box.apply_transform(trimesh.transformations.rotation_matrix(np.radians(35), [0, 0, 1]))
    assert oriented_size(box.vertices) == pytest.approx([0.3, 0.1, 0.02], abs=1e-6)


def test_bundle_lists_scanned_objects(scene):
    meta = _object_metadata(_cup(scene))
    assert meta["mesh"] == "objects/obj_0_cup.glb"
    assert meta["size_m"] == pytest.approx(CUP_SIZE.tolist())
    json.dumps(meta)  # serialisable


def test_reduced_hull_stays_inside_the_mesh():
    from scan2sim.object_mesh import HULL_MAX_VERTICES, convex_hull

    rng = np.random.default_rng(3)
    points = rng.normal(size=(4000, 3)) * np.array([0.17, 0.15, 0.02])  # a flat, laptop-like blob
    vertices, faces = convex_hull(points)
    assert len(vertices) <= HULL_MAX_VERTICES
    assert vertices[:, 2].min() >= points[:, 2].min() - 1e-9
    assert vertices[:, 2].max() <= points[:, 2].max() + 1e-9
    assert np.all(np.abs(vertices).max(axis=0) <= np.abs(points).max(axis=0) + 1e-9)
