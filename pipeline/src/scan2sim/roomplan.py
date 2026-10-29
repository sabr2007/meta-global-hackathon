"""Parse RoomPlan's CapturedRoom JSON (Codable encoding) into typed elements."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from scan2sim.frames import mat4_from_column_major

SURFACE_KINDS = ("floors", "walls", "doors", "windows", "openings")
CONFIDENCE_LEVELS = ("low", "medium", "high")


@dataclass(frozen=True)
class RoomElement:
    """One RoomPlan surface or object, still in ARKit coordinates."""

    kind: str  # floor | wall | door | window | opening | object
    category: str  # e.g. wall, table, chair, sofa
    identifier: str
    dimensions: tuple[float, float, float]  # width, height, depth in the element's local x, y, z
    pose_arkit: np.ndarray  # 4x4, centred on the element
    confidence: str
    parent: str | None = None
    attributes: dict[str, str] = field(default_factory=dict)
    polygon: np.ndarray | None = None  # outline corners in the element's local frame (floors), (N, 3)


@dataclass(frozen=True)
class Room:
    elements: tuple[RoomElement, ...]
    section_label: str | None

    def of_kind(self, kind: str) -> tuple[RoomElement, ...]:
        return tuple(e for e in self.elements if e.kind == kind)


def _enum_name(value: Any, field_name: str) -> str:
    """Swift enums are encoded as {"case": {}}; return the case name."""
    if isinstance(value, dict) and len(value) == 1:
        return next(iter(value))
    if isinstance(value, str):
        return value
    raise ValueError(f"cannot read enum field {field_name!r}: {value!r}")


def _parse_element(raw: dict[str, Any], kind: str) -> RoomElement:
    dimensions = raw.get("dimensions")
    if not isinstance(dimensions, list) or len(dimensions) != 3:
        raise ValueError(f"{kind} {raw.get('identifier')}: bad dimensions {dimensions!r}")
    confidence = _enum_name(raw.get("confidence", {"medium": {}}), "confidence")
    if confidence not in CONFIDENCE_LEVELS:
        raise ValueError(f"{kind} {raw.get('identifier')}: unknown confidence {confidence!r}")
    corners = raw.get("polygonCorners") or []
    polygon = np.asarray(corners, dtype=np.float64) if len(corners) >= 3 else None
    if polygon is not None and polygon.shape[1:] != (3,):
        raise ValueError(f"{kind} {raw.get('identifier')}: bad polygonCorners shape {polygon.shape}")
    return RoomElement(
        kind=kind,
        category=_enum_name(raw["category"], "category"),
        identifier=str(raw["identifier"]),
        dimensions=(float(dimensions[0]), float(dimensions[1]), float(dimensions[2])),
        pose_arkit=mat4_from_column_major(raw["transform"]),
        confidence=confidence,
        parent=raw.get("parentIdentifier"),
        attributes={str(k): str(v) for k, v in (raw.get("attributes") or {}).items()},
        polygon=polygon,
    )


def parse_room(raw: dict[str, Any]) -> Room:
    """Parse a rooms/room-N.json document."""
    elements: list[RoomElement] = []
    for plural in SURFACE_KINDS:
        elements.extend(_parse_element(item, plural[:-1]) for item in raw.get(plural) or [])
    elements.extend(_parse_element(item, "object") for item in raw.get("objects") or [])
    sections = raw.get("sections") or []
    label = sections[0].get("label") if sections else None
    return Room(elements=tuple(elements), section_label=label)
