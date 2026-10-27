import mujoco
import numpy as np
import pytest

from fixtures import ROOM_D, ROOM_W, TABLE_H, room_document
from scan2sim.mjcf import scene_to_mjcf
from scan2sim.roomplan import parse_room
from scan2sim.scene import PROBE_HALF_SIZE, PROBE_RADIUS, WALL_THICKNESS, build_scene

SETTLE_SECONDS = 2.0


@pytest.fixture
def scene():
    return build_scene(parse_room(room_document()), probe_count=4)


def test_floor_is_world_origin(scene):
    assert np.allclose(scene.floor.center, 0.0, atol=1e-9)


def test_table_top_matches_its_height(scene):
    (table,) = [b for b in scene.boxes if b.category == "table"]
    assert table.top_z == pytest.approx(TABLE_H, abs=1e-6)
    assert table.collides


def test_walls_are_thickened_outwards(scene):
    walls = [b for b in scene.boxes if b.kind == "wall"]
    assert all(b.half_size[2] == pytest.approx(WALL_THICKNESS / 2) for b in walls)
    distances = sorted(float(np.linalg.norm(b.center[:2])) for b in walls)
    expected = sorted([ROOM_D / 2, ROOM_D / 2, ROOM_W / 2, ROOM_W / 2])
    assert distances == pytest.approx([d + WALL_THICKNESS / 2 for d in expected], abs=1e-6)


def test_windows_do_not_collide(scene):
    (window,) = [b for b in scene.boxes if b.kind == "window"]
    assert not window.collides


def test_probes_settle_on_the_table(scene):
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(scene))
    data = mujoco.MjData(model)
    for _ in range(int(SETTLE_SECONDS / model.opt.timestep)):
        mujoco.mj_step(model, data)
    resting_heights = {"box": TABLE_H + PROBE_HALF_SIZE, "sphere": TABLE_H + PROBE_RADIUS}
    for probe in scene.probes:
        z = data.body(probe.name).xpos[2]
        assert z == pytest.approx(resting_heights[probe.shape], abs=5e-3), probe.name


def test_zero_probes_is_allowed():
    assert build_scene(parse_room(room_document()), probe_count=0).probes == ()


def test_room_without_table_still_gets_probes():
    doc = room_document()
    doc["objects"] = []
    scene = build_scene(parse_room(doc), probe_count=3)
    assert len(scene.probes) == 3
    assert all(p.position[2] > 0.5 for p in scene.probes)
