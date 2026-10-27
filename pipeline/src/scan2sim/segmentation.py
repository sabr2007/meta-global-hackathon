"""SAM 3.1 concept segmentation of a single image, parsed with Meta's official parser."""

from __future__ import annotations

from dataclasses import dataclass

import meta_sam_parser as msp
import numpy as np
from openai import AsyncOpenAI

from scan2sim.meta_client import SAM_MODEL


@dataclass(frozen=True)
class ObjectMask:
    """One SAM instance. Pixel coordinates are in the image that was sent (upright)."""

    concept: str
    object_id: str
    box: tuple[int, int, int, int]  # left, top, right, bottom
    confidence: float | None
    mask_origin: tuple[int, int]  # left, top of the mask raster
    mask: np.ndarray  # (H, W) bool

    @property
    def area_px(self) -> int:
        return int(self.mask.sum())

    def pixel_coords(self) -> np.ndarray:
        """(N, 2) x, y image coordinates of every mask pixel."""
        rows, cols = np.nonzero(self.mask)
        return np.column_stack([cols + self.mask_origin[0], rows + self.mask_origin[1]])


def masks_from_result(concept: str, result) -> tuple[ObjectMask, ...]:
    boxes = {r.object_id: r for r in result.records if r.kind == "box"}
    masks = []
    for record in result.records:
        if record.kind != "mask":
            continue
        box = boxes.get(record.object_id)
        bounds = record.bounds
        raster = np.frombuffer(msp.decode_mask_to_raster(record.mask), dtype=np.uint8)
        shaped = raster.reshape(record.mask.height, record.mask.width).astype(bool)
        masks.append(
            ObjectMask(
                concept=concept,
                object_id=str(record.object_id),
                box=(box.left, box.top, box.right, box.bottom) if box else (bounds.left, bounds.top, bounds.right, bounds.bottom),
                confidence=record.confidence,
                mask_origin=(bounds.left, bounds.top),
                mask=shaped,
            )
        )
    return tuple(masks)


async def segment_concept(client: AsyncOpenAI, image_data_url: str, concept: str) -> tuple[ObjectMask, ...]:
    stream = await client.responses.create(
        model=SAM_MODEL,
        stream=True,
        metadata={"include_confidence": "true"},
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": concept},
                    {"type": "input_image", "image_url": image_data_url},
                ],
            }
        ],
    )
    result = await msp.parse_responses_stream(stream, msp.image_segmentation_format()).final_result()
    if result.outcome.status != "completed":
        raise RuntimeError(f"SAM 3.1 did not complete for {concept!r}: {result.outcome}")
    return masks_from_result(concept, result)
