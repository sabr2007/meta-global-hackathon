"""Muse Spark looks at a photo and lists the objects a robot could manipulate.

The output is schema-constrained (structured output), and each object carries
a short noun phrase written for SAM 3.1 ("orange ring", not "the ring on the right").
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from openai import AsyncOpenAI

from scan2sim.meta_client import SPARK_MODEL

MAX_OBJECTS = 12

DISCOVERY_SCHEMA = {
    "type": "object",
    "properties": {
        "objects": {
            "type": "array",
            "maxItems": MAX_OBJECTS,
            "items": {
                "type": "object",
                "properties": {
                    "concept": {
                        "type": "string",
                        "description": "1-3 word noun phrase for a segmentation model: colour/material + noun",
                    },
                    "label": {"type": "string", "description": "what the object most likely is"},
                    "graspable": {"type": "boolean", "description": "a robot hand could pick it up"},
                    "approx_longest_side_cm": {"type": "number"},
                    "count": {"type": "integer", "description": "how many instances are visible"},
                },
                "required": ["concept", "label", "graspable", "approx_longest_side_cm", "count"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objects"],
    "additionalProperties": False,
}

DISCOVERY_PROMPT = """You are cataloguing a real room for a robot simulator.
List the distinct movable objects in this photo that a robot could pick up, push or open:
small and medium things (under ~60 cm). Skip furniture, walls, curtains, rugs, cables,
and anything fixed in place.

For each object give a `concept`: a short noun phrase a segmentation model can match,
1-3 words, concrete colour or material + noun (e.g. "white keyboard", "orange ring").
No spatial words, no verbs, no lists. Make concepts distinct so two objects never share one.
If you are not sure what something is, describe its look instead of guessing a brand.
Only list objects you can actually see."""


@dataclass(frozen=True)
class DiscoveredObject:
    concept: str
    label: str
    graspable: bool
    approx_longest_side_cm: float
    count: int


def parse_discovery(payload: str) -> tuple[DiscoveredObject, ...]:
    """Validate the model's JSON and drop duplicate or empty concepts."""
    data = json.loads(payload)
    seen: set[str] = set()
    objects = []
    for item in data.get("objects", []):
        concept = " ".join(str(item.get("concept", "")).lower().split())
        if not concept or concept in seen or "," in concept:
            continue
        seen.add(concept)
        objects.append(
            DiscoveredObject(
                concept=concept,
                label=str(item.get("label", concept)),
                graspable=bool(item.get("graspable", False)),
                approx_longest_side_cm=float(item.get("approx_longest_side_cm", 0.0)),
                count=max(int(item.get("count", 1)), 1),
            )
        )
    return tuple(objects)


async def discover_objects(client: AsyncOpenAI, image_data_url: str) -> tuple[DiscoveredObject, ...]:
    response = await client.responses.create(
        model=SPARK_MODEL,
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": DISCOVERY_PROMPT},
                    {"type": "input_image", "image_url": image_data_url},
                ],
            }
        ],
        text={"format": {"type": "json_schema", "name": "room_objects", "schema": DISCOVERY_SCHEMA, "strict": True}},
    )
    if response.status != "completed":
        raise RuntimeError(f"Muse Spark discovery did not complete: {response.status} {response.incomplete_details}")
    return parse_discovery(response.output_text)
