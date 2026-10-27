"""Step 4-5 on one photo: Muse Spark discovers objects, SAM 3.1 segments each of them."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from scan2sim.discovery import DiscoveredObject, discover_objects
from scan2sim.images import UprightImage, load_upright
from scan2sim.meta_client import MetaSettings, async_client
from scan2sim.segmentation import ObjectMask, segment_concept

MODEL_MAX_SIDE = 1920  # send photos at full capture resolution
SAM_CONCURRENCY = 4
OVERLAY_ALPHA = 0.45

PALETTE = (
    (239, 106, 46), (46, 134, 239), (250, 196, 38), (90, 196, 110), (214, 76, 160),
    (140, 112, 239), (40, 190, 190), (230, 70, 70), (120, 120, 120), (180, 140, 60),
)


@dataclass(frozen=True)
class Perception:
    photo: Path
    image: UprightImage
    objects: tuple[DiscoveredObject, ...]
    masks: tuple[ObjectMask, ...]
    timings_s: dict[str, float]


async def perceive_photo(settings: MetaSettings, photo: Path) -> Perception:
    image = load_upright(photo, max_side=MODEL_MAX_SIDE)
    url = image.data_url()
    async with async_client(settings) as client:
        started = time.perf_counter()
        objects = await discover_objects(client, url)
        discovered_at = time.perf_counter()

        gate = asyncio.Semaphore(SAM_CONCURRENCY)

        async def segment(obj: DiscoveredObject) -> tuple[ObjectMask, ...]:
            async with gate:
                return await segment_concept(client, url, obj.concept)

        per_concept = await asyncio.gather(*(segment(o) for o in objects))
        finished = time.perf_counter()
    return Perception(
        photo=photo,
        image=image,
        objects=objects,
        masks=tuple(m for group in per_concept for m in group),
        timings_s={"discovery": round(discovered_at - started, 2), "segmentation": round(finished - discovered_at, 2)},
    )


def render_overlay(perception: Perception) -> Image.Image:
    base = perception.image.image.convert("RGBA")
    layer = np.zeros((base.height, base.width, 4), dtype=np.uint8)
    colors = {o.concept: PALETTE[i % len(PALETTE)] for i, o in enumerate(perception.objects)}
    for m in perception.masks:
        x0, y0 = m.mask_origin
        h, w = m.mask.shape
        region = layer[y0 : y0 + h, x0 : x0 + w]
        region[m.mask[: region.shape[0], : region.shape[1]]] = (*colors[m.concept], int(255 * OVERLAY_ALPHA))
    composed = Image.alpha_composite(base, Image.fromarray(layer, "RGBA"))
    draw = ImageDraw.Draw(composed)
    for m in perception.masks:
        color = colors[m.concept]
        draw.rectangle(m.box, outline=(*color, 255), width=3)
        label = m.concept if m.confidence is None else f"{m.concept} {m.confidence:.2f}"
        draw.text((m.box[0] + 4, max(m.box[1] - 14, 0)), label, fill=(*color, 255))
    return composed.convert("RGB")


def perception_summary(perception: Perception) -> dict:
    return {
        "photo": perception.photo.name,
        "image_size": list(perception.image.image.size),
        "timings_s": perception.timings_s,
        "objects": [
            {
                "concept": o.concept,
                "label": o.label,
                "graspable": o.graspable,
                "approx_longest_side_cm": o.approx_longest_side_cm,
                "expected_count": o.count,
                "found": sum(1 for m in perception.masks if m.concept == o.concept),
            }
            for o in perception.objects
        ],
        "masks": [
            {
                "concept": m.concept,
                "object_id": m.object_id,
                "box": list(m.box),
                "confidence": m.confidence,
                "area_px": m.area_px,
            }
            for m in perception.masks
        ],
    }


def write_perception(perception: Perception, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = perception.photo.stem
    overlay_path = out_dir / f"perception-{stem}.jpg"
    summary_path = out_dir / f"perception-{stem}.json"
    render_overlay(perception).save(overlay_path, quality=88)
    summary_path.write_text(json.dumps(perception_summary(perception), indent=2) + "\n")
    return overlay_path, summary_path
