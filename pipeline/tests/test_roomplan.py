import pytest

from fixtures import TABLE_H, TABLE_W, room_document
from scan2sim.roomplan import parse_room


def test_parses_every_element_kind():
    room = parse_room(room_document())
    assert len(room.of_kind("floor")) == 1
    assert len(room.of_kind("wall")) == 4
    assert len(room.of_kind("window")) == 1
    assert room.section_label == "livingRoom"


def test_object_category_dimensions_and_attributes():
    (table,) = parse_room(room_document()).of_kind("object")
    assert table.category == "table"
    assert table.dimensions[:2] == pytest.approx((TABLE_W, TABLE_H))
    assert table.attributes == {"TableShapeType": "rectangular"}
    assert table.confidence == "high"


def test_rejects_malformed_dimensions():
    doc = room_document()
    doc["objects"][0]["dimensions"] = [1.0, 2.0]
    with pytest.raises(ValueError, match="bad dimensions"):
        parse_room(doc)


def test_rejects_unknown_confidence():
    doc = room_document()
    doc["objects"][0]["confidence"] = {"certain": {}}
    with pytest.raises(ValueError, match="unknown confidence"):
        parse_room(doc)
