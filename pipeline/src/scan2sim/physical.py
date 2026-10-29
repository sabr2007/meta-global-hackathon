"""Mass and friction of every scanned object, estimated by Muse Spark from the hero photo.

Without them every object gets the same density (600 kg/m^3 of its convex hull) and friction: the
laptop on our desk weighed 4.8 kg and the earbud case 29 g (an AirPods Pro case is 51 g, a 13" laptop
about 1.2 kg). Muse Spark sees the photo with every object's name and measured size and answers, as
structured output, its mass, its sliding friction on the table and a one-line reason. The answer is
cached with the other paid results, keyed by the objects it was asked about.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI

from scan2sim.images import UprightImage
from scan2sim.meta_client import SPARK_MODEL, MetaSettings, async_client

CACHE_FILE = "physical.json"
MASS_RANGE_KG = (0.002, 25.0)  # a paper clip to a full crate; anything outside is a misread
FRICTION_RANGE = (0.05, 1.5)

PHYSICAL_SCHEMA = {
    "type": "object",
    "properties": {
        "objects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "the object's name exactly as listed"},
                    "mass_kg": {"type": "number"},
                    "friction": {"type": "number", "description": "sliding friction coefficient on the table top"},
                    "reason": {"type": "string", "description": "one short line: material, contents, why this mass"},
                },
                "required": ["name", "mass_kg", "friction", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["objects"],
    "additionalProperties": False,
}

PHYSICAL_PROMPT = """You are setting up a physics simulation of the objects on the table in this photo.
For every object listed below (name: what it is, measured size in cm), estimate
- mass_kg: its real mass as it is in the photo (is a bottle full, empty, half full?);
- friction: the Coulomb sliding friction coefficient between it and the table top it stands on;
- reason: one short line on the material and contents behind these numbers.
Answer for every name exactly as written.

"""


@dataclass(frozen=True)
class PhysicalProperties:
    mass_kg: float
    friction: float
    reason: str


def objects_key(objects: list[tuple[str, str, tuple[float, ...]]]) -> str:
    """Fingerprint of the question: model, prompt, names and labels. Sizes are context only, so a
    rebuild that places an object a millimetre differently does not pay for a new answer."""
    rows = [[name, label] for name, label, _ in objects]
    return hashlib.sha256(json.dumps([SPARK_MODEL, PHYSICAL_PROMPT, rows]).encode()).hexdigest()[:16]


def object_listing(objects: list[tuple[str, str, tuple[float, ...]]]) -> str:
    return "\n".join(f"- {name}: {label}, {' x '.join(f'{v * 100:.1f}' for v in size)} cm" for name, label, size in objects)


def parse_properties(payload: str, names: list[str]) -> dict[str, PhysicalProperties]:
    """Validate the model's JSON: known names only, numbers clamped to plausible ranges."""
    properties = {}
    for item in json.loads(payload).get("objects", []):
        name = str(item.get("name", ""))
        if name not in names or name in properties:
            continue
        mass = min(max(float(item["mass_kg"]), MASS_RANGE_KG[0]), MASS_RANGE_KG[1])
        friction = min(max(float(item["friction"]), FRICTION_RANGE[0]), FRICTION_RANGE[1])
        properties[name] = PhysicalProperties(mass, friction, " ".join(str(item.get("reason", "")).split()))
    return properties


async def ask_spark(client: AsyncOpenAI, image: UprightImage, objects: list[tuple[str, str, tuple[float, ...]]]) -> tuple[str, dict]:
    """Muse Spark's raw answer and its token usage."""
    response = await client.responses.create(
        model=SPARK_MODEL,
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": PHYSICAL_PROMPT + object_listing(objects)},
                    {"type": "input_image", "image_url": image.data_url()},
                ],
            }
        ],
        text={"format": {"type": "json_schema", "name": "physical_properties", "schema": PHYSICAL_SCHEMA, "strict": True}},
    )
    if response.status != "completed":
        raise RuntimeError(f"Muse Spark did not finish the physical estimate: {response.status} {response.incomplete_details}")
    usage = {"input_tokens": response.usage.input_tokens, "output_tokens": response.usage.output_tokens}
    return response.output_text, usage


async def physical_properties(
    settings: MetaSettings, image: UprightImage, objects: list[tuple[str, str, tuple[float, ...]]], cache: Path | None
) -> dict[str, PhysicalProperties]:
    """Mass, friction and reason per object name, from the cache when the same objects were asked about."""
    path = cache / CACHE_FILE if cache else None
    key = objects_key(objects)
    names = [name for name, _, _ in objects]
    if path and path.exists():
        cached = json.loads(path.read_text())
        if cached.get("key") == key:
            return parse_properties(json.dumps(cached["answer"]), names)
    async with async_client(settings) as client:
        payload, usage = await ask_spark(client, image, objects)
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"key": key, "model": SPARK_MODEL, "asked": object_listing(objects), "usage": usage, "answer": json.loads(payload)}
        path.write_text(json.dumps(record, indent=1) + "\n")
    return parse_properties(payload, names)
