import asyncio
import dataclasses
import json

import mujoco
import pytest
from PIL import Image

from fixtures import cup_on_table, ring_on_table, room_document
from scan2sim import physical
from scan2sim.export import _object_metadata
from scan2sim.images import UprightImage
from scan2sim.meta_client import MetaSettings
from scan2sim.mjcf import scene_to_mjcf
from scan2sim.physical import FRICTION_RANGE, MASS_RANGE_KG, PhysicalProperties, parse_properties, physical_properties
from scan2sim.roomplan import parse_room
from scan2sim.scene import build_scene

OBJECTS = [("obj_0_cup", "cup", (0.08, 0.06, 0.10)), ("obj_1_ring", "ring", (0.074, 0.074, 0.02))]
ANSWER = {
    "objects": [
        {"name": "obj_0_cup", "mass_kg": 0.3, "friction": 0.5, "reason": "ceramic mug, empty"},
        {"name": "obj_1_ring", "mass_kg": 0.04, "friction": 0.8, "reason": "soft rubber toy"},
    ]
}


@pytest.fixture
def scene():
    return build_scene(parse_room(room_document()), probe_count=0)


def test_parse_properties_keeps_listed_names_and_plausible_numbers():
    payload = json.dumps(
        {
            "objects": [
                {"name": "obj_0_cup", "mass_kg": 400.0, "friction": -1.0, "reason": "  a   cup "},
                {"name": "obj_0_cup", "mass_kg": 0.2, "friction": 0.5, "reason": "duplicate"},
                {"name": "obj_9_ghost", "mass_kg": 0.2, "friction": 0.5, "reason": "not asked about"},
            ]
        }
    )
    assert parse_properties(payload, ["obj_0_cup", "obj_1_ring"]) == {
        "obj_0_cup": PhysicalProperties(MASS_RANGE_KG[1], FRICTION_RANGE[0], "a cup")
    }


def test_spark_is_asked_once_and_the_answer_cached(tmp_path, monkeypatch):
    calls = []

    async def fake_ask(client, image, objects):
        calls.append(objects)
        return json.dumps(ANSWER), {"input_tokens": 1200, "output_tokens": 150}

    monkeypatch.setattr(physical, "ask_spark", fake_ask)
    image = UprightImage(Image.new("RGB", (8, 8)), (8, 8), 0, 1.0)
    settings = MetaSettings(api_key="test", base_url="https://example.invalid/v1")
    first = asyncio.run(physical_properties(settings, image, OBJECTS, tmp_path))
    again = asyncio.run(physical_properties(settings, image, OBJECTS, tmp_path))
    resized = asyncio.run(physical_properties(settings, image, [OBJECTS[0][:2] + ((0.07, 0.06, 0.10),)], tmp_path))

    assert first == again and first["obj_1_ring"] == PhysicalProperties(0.04, 0.8, "soft rubber toy")
    assert len(calls) == 2  # the resized cup is a new question
    assert set(resized) == {"obj_0_cup"}
    assert json.loads((tmp_path / physical.CACHE_FILE).read_text())["usage"]["output_tokens"] == 150


def test_estimated_mass_and_friction_reach_the_simulation_and_the_bundle(scene):
    cup = dataclasses.replace(cup_on_table(scene), mass_kg=0.3, friction=0.5, physics_reason="ceramic mug, empty")
    ring = dataclasses.replace(ring_on_table(scene, decomposed=True), name="obj_1_ring", mass_kg=0.04, friction=0.8)
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(dataclasses.replace(scene, objects=(cup, ring))))
    assert model.body("obj_0_cup").mass[0] == pytest.approx(0.3)
    assert model.geom("obj_0_cup_geom").friction[0] == pytest.approx(0.5)
    assert model.body("obj_1_ring").mass[0] == pytest.approx(0.04, rel=1e-4)  # shared by its pieces
    assert model.geom("obj_1_ring_piece0").friction[0] == pytest.approx(0.8)
    assert _object_metadata(cup)["physical"] == {"mass_kg": 0.3, "friction": 0.5, "reason": "ceramic mug, empty"}
    assert _object_metadata(cup_on_table(scene))["physical"] is None
