"""Agentic check of SAM output with Muse Spark.

1. Review: Spark looks at a crop of every mask and says what it really is and
   whether it is one whole, graspable object (fixes "white mouse" that is
   actually an AirPods case, drops fragments).
2. Recover: for concepts SAM missed, Spark grounds a box (0-1000 grid) and
   SAM segments inside that box via an object prompt.
3. Dedupe: the same physical object found twice keeps one mask.
"""

from __future__ import annotations

import base64
import io
import json
from dataclasses import dataclass, replace

import meta_sam_parser as msp
import numpy as np
from openai import AsyncOpenAI

from scan2sim.discovery import DiscoveredObject
from scan2sim.images import UprightImage
from scan2sim.meta_client import SAM_MODEL, SPARK_MODEL
from scan2sim.segmentation import ObjectMask, masks_from_result

CROP_PADDING = 0.35  # context around each mask, as a fraction of its box size
CROP_MAX_SIDE = 384
DUPLICATE_IOU = 0.5
GRID = 1000  # Muse Spark grounding grid


@dataclass(frozen=True)
class VerifiedObject:
    mask: ObjectMask
    label: str
    graspable: bool
    source: str  # "concept" | "spark-box"


REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "crops": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "label": {"type": "string", "description": "what the highlighted object really is, 1-4 words"},
                    "single_whole_object": {"type": "boolean"},
                    "graspable": {"type": "boolean"},
                    "keep": {"type": "boolean"},
                },
                "required": ["index", "label", "single_whole_object", "graspable", "keep"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["crops"],
    "additionalProperties": False,
}

LOCATE_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "concept": {"type": "string"},
                    "visible": {"type": "boolean"},
                    "box_2d": {"type": "array", "items": {"type": "integer"}, "description": "[x1, y1, x2, y2] on a 0-1000 grid"},
                },
                "required": ["concept", "visible", "box_2d"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["found"],
    "additionalProperties": False,
}


def _crop_data_url(image: UprightImage, mask: ObjectMask) -> str:
    """Crop around the mask; dim everything outside the mask so Spark knows which object is meant."""
    left, top, right, bottom = mask.box
    pad_x, pad_y = (right - left) * CROP_PADDING, (bottom - top) * CROP_PADDING
    box = (
        max(int(left - pad_x), 0),
        max(int(top - pad_y), 0),
        min(int(right + pad_x), image.image.width),
        min(int(bottom + pad_y), image.image.height),
    )
    pixels = np.asarray(image.image, dtype=np.float32).copy()
    inside = np.zeros(pixels.shape[:2], dtype=bool)
    x0, y0 = mask.mask_origin
    h, w = mask.mask.shape
    inside[y0 : y0 + h, x0 : x0 + w] = mask.mask[: pixels.shape[0] - y0, : pixels.shape[1] - x0]
    pixels[~inside] *= 0.35
    from PIL import Image  # local: only needed here

    crop = Image.fromarray(pixels.astype(np.uint8)).crop(box)
    crop.thumbnail((CROP_MAX_SIDE, CROP_MAX_SIDE))
    buffer = io.BytesIO()
    crop.save(buffer, "JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


async def review_masks(client: AsyncOpenAI, image: UprightImage, masks: tuple[ObjectMask, ...]) -> list[dict]:
    if not masks:
        return []
    content: list[dict] = [
        {
            "type": "input_text",
            "text": (
                "Each image below is a crop from a room photo; the bright region is one segmented object, "
                "the dimmed part is context. For every crop say what the bright object really is, whether it "
                "is a single whole object (not a fragment, not several objects), whether a robot hand could "
                "pick it up, and whether to keep it for a robot simulator (keep only real, movable objects)."
            ),
        }
    ]
    for i, mask in enumerate(masks):
        content.append({"type": "input_text", "text": f"Crop {i} (segmented as '{mask.concept}'):"})
        content.append({"type": "input_image", "image_url": _crop_data_url(image, mask)})
    response = await client.responses.create(
        model=SPARK_MODEL,
        input=[{"type": "message", "role": "user", "content": content}],
        text={"format": {"type": "json_schema", "name": "crop_review", "schema": REVIEW_SCHEMA, "strict": True}},
    )
    return json.loads(response.output_text)["crops"]


async def locate_missing(client: AsyncOpenAI, image_url: str, concepts: list[str]) -> list[dict]:
    if not concepts:
        return []
    listing = "\n".join(f"- {c}" for c in concepts)
    response = await client.responses.create(
        model=SPARK_MODEL,
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "Locate each of these objects in the photo. Give a tight box_2d [x1, y1, x2, y2] on a "
                            f"0-{GRID} grid (x right, y down). If an object is not visible, set visible=false and "
                            f"box_2d=[0,0,0,0].\n{listing}"
                        ),
                    },
                    {"type": "input_image", "image_url": image_url},
                ],
            }
        ],
        text={"format": {"type": "json_schema", "name": "locate", "schema": LOCATE_SCHEMA, "strict": True}},
    )
    return json.loads(response.output_text)["found"]


async def segment_box(client: AsyncOpenAI, image: UprightImage, image_url: str, concept: str, box_2d: list[int]) -> tuple[ObjectMask, ...]:
    width, height = image.image.size
    x1, y1, x2, y2 = [min(max(v, 0), GRID) for v in box_2d]
    box = msp.PromptBox(
        left=round(x1 / GRID * (width - 1)),
        top=round(y1 / GRID * (height - 1)),
        right=round(x2 / GRID * (width - 1)),
        bottom=round(y2 / GRID * (height - 1)),
    )
    if box.right <= box.left or box.bottom <= box.top:
        return ()
    prompt = msp.build_object_prompt(size=(width, height), objects=[msp.PromptObject(id=1, prompts=[msp.FramePrompt(frame=0, box=box)])])
    stream = await client.responses.create(
        model=SAM_MODEL,
        stream=True,
        metadata={"include_confidence": "true"},
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}, {"type": "input_image", "image_url": image_url}],
            }
        ],
    )
    result = await msp.parse_responses_stream(stream, msp.image_segmentation_format()).final_result()
    return masks_from_result(concept, result)


def mask_iou(a: ObjectMask, b: ObjectMask) -> float:
    ax0, ay0 = a.mask_origin
    bx0, by0 = b.mask_origin
    x0, y0 = min(ax0, bx0), min(ay0, by0)
    x1 = max(ax0 + a.mask.shape[1], bx0 + b.mask.shape[1])
    y1 = max(ay0 + a.mask.shape[0], by0 + b.mask.shape[0])
    canvas_a = np.zeros((y1 - y0, x1 - x0), dtype=bool)
    canvas_b = np.zeros_like(canvas_a)
    canvas_a[ay0 - y0 : ay0 - y0 + a.mask.shape[0], ax0 - x0 : ax0 - x0 + a.mask.shape[1]] = a.mask
    canvas_b[by0 - y0 : by0 - y0 + b.mask.shape[0], bx0 - x0 : bx0 - x0 + b.mask.shape[1]] = b.mask
    union = np.logical_or(canvas_a, canvas_b).sum()
    return float(np.logical_and(canvas_a, canvas_b).sum() / union) if union else 0.0


def dedupe(objects: list[VerifiedObject]) -> list[VerifiedObject]:
    """Keep the most confident of overlapping masks."""
    ranked = sorted(objects, key=lambda o: o.mask.confidence or 0.0, reverse=True)
    kept: list[VerifiedObject] = []
    for candidate in ranked:
        if all(mask_iou(candidate.mask, k.mask) < DUPLICATE_IOU for k in kept):
            kept.append(candidate)
    return kept


async def verify(
    client: AsyncOpenAI,
    image: UprightImage,
    image_url: str,
    discovered: tuple[DiscoveredObject, ...],
    masks: tuple[ObjectMask, ...],
) -> tuple[list[VerifiedObject], dict]:
    found_concepts = {m.concept for m in masks}
    missing = [o.concept for o in discovered if o.concept not in found_concepts]
    located = await locate_missing(client, image_url, missing)
    recovered: list[ObjectMask] = []
    for hit in located:
        if hit["visible"] and hit["concept"] in missing:
            recovered.extend(await segment_box(client, image, image_url, hit["concept"], hit["box_2d"]))

    candidates = list(masks) + recovered
    reviews = {r["index"]: r for r in await review_masks(client, image, tuple(candidates))}
    verified = []
    for i, mask in enumerate(candidates):
        review = reviews.get(i)
        if review is None or not review["keep"] or not review["single_whole_object"]:
            continue
        verified.append(
            VerifiedObject(
                mask=replace(mask, concept=mask.concept),
                label=review["label"],
                graspable=review["graspable"],
                source="concept" if i < len(masks) else "spark-box",
            )
        )
    report = {
        "missing_after_concepts": missing,
        "located_by_spark": [h["concept"] for h in located if h["visible"]],
        "recovered_masks": len(recovered),
        "reviews": [reviews.get(i) for i in range(len(candidates))],
    }
    return dedupe(verified), report
