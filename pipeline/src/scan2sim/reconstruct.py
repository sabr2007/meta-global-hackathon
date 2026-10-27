"""SAM 3D Objects (Meta, open weights) hosted on fal: one photo + one mask per object -> meshes + poses.

fal returns every object as a canonical mesh (glTF, +Y up, about one unit across) plus SAM 3D's
layout pose. Two details are not in fal's docs; both were measured against LiDAR (see placement.py):
the rotation quaternion comes as (w, x, y, z), not (x, y, z, w), and the pose acts on SAM 3D's
internal +Z-up frame with PyTorch3D conventions.
"""

from __future__ import annotations

import asyncio
import io
import os
from dataclasses import dataclass
from pathlib import Path

import fal_client
import httpx
import numpy as np
from dotenv import load_dotenv
from PIL import Image

from scan2sim.images import UprightImage
from scan2sim.segmentation import ObjectMask

FAL_APP = "fal-ai/sam-3/3d-objects"
DEFAULT_SEED = 42
PHOTO_JPEG_QUALITY = 95
REQUEST_TIMEOUT_S = 900.0  # seven objects in one request took 133 s
DOWNLOAD_TIMEOUT_S = 300.0

_REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class ObjectPose:
    """SAM 3D layout: canonical object -> PyTorch3D camera (x left, y up, z forward)."""

    rotation_wxyz: np.ndarray
    translation: np.ndarray
    scale: float


@dataclass(frozen=True)
class ObjectReconstruction:
    index: int  # position of the object's mask in the request
    glb: bytes  # canonical mesh with vertex colours
    pose: ObjectPose


def fal_key() -> str:
    load_dotenv(_REPO_ROOT / ".env", override=False)
    key = os.environ.get("FAL_KEY", "").strip()
    if not key:
        raise RuntimeError("FAL_KEY is not set. Put it in .env at the repo root (see .env.example).")
    return key


def mask_png(image: UprightImage, mask: ObjectMask) -> bytes:
    """Full-frame single-channel mask, white = object, as fal expects."""
    canvas = np.zeros((image.image.height, image.image.width), dtype=np.uint8)
    x0, y0 = mask.mask_origin
    h, w = mask.mask.shape
    canvas[y0 : y0 + h, x0 : x0 + w][mask.mask[: canvas.shape[0] - y0, : canvas.shape[1] - x0]] = 255
    buffer = io.BytesIO()
    Image.fromarray(canvas, "L").save(buffer, "PNG")
    return buffer.getvalue()


def _vector(value) -> np.ndarray:
    """fal nests every vector one level deeper than its docs say: [[x, y, z]]."""
    return np.asarray(value, dtype=np.float64).reshape(-1)


def parse_pose(metadata: dict) -> ObjectPose:
    rotation = _vector(metadata["rotation"])
    scale = _vector(metadata["scale"])
    if rotation.shape != (4,) or not np.allclose(scale, scale[0]):
        raise ValueError(f"unexpected SAM 3D pose: {metadata}")
    return ObjectPose(
        rotation_wxyz=rotation / np.linalg.norm(rotation),
        translation=_vector(metadata["translation"]),
        scale=float(scale[0]),
    )


def request_arguments(image_url: str, mask_urls: list[str], seed: int) -> dict:
    # prompt=None: the masks select the objects; the endpoint's default text prompt is "car".
    return {"image_url": image_url, "mask_urls": mask_urls, "prompt": None, "seed": seed}


def mesh_urls(result: dict, count: int) -> list[str | None]:
    """Per-object GLB URLs. A single-object request has no individual_glbs, only model_glb."""
    if count == 1:
        return [result["model_glb"]["url"]]
    files = result.get("individual_glbs") or []
    if len(files) != count:
        raise RuntimeError(f"fal returned {len(files)} meshes for {count} masks")
    return [f["url"] if f else None for f in files]


async def reconstruct_objects(
    image: UprightImage,
    masks: list[ObjectMask],
    seed: int = DEFAULT_SEED,
) -> list[ObjectReconstruction | None]:
    """One fal request for all masks; None where SAM 3D produced no mesh for an object."""
    if not masks:
        return []
    client = fal_client.AsyncClient(key=fal_key(), default_timeout=REQUEST_TIMEOUT_S)
    photo = io.BytesIO()
    image.image.save(photo, "JPEG", quality=PHOTO_JPEG_QUALITY)
    image_url = await client.upload(photo.getvalue(), "image/jpeg", "photo.jpg")
    mask_urls = await asyncio.gather(
        *(client.upload(mask_png(image, m), "image/png", f"mask_{i}.png") for i, m in enumerate(masks))
    )
    result = await client.subscribe(FAL_APP, request_arguments(image_url, list(mask_urls), seed), client_timeout=REQUEST_TIMEOUT_S)
    poses = {int(m["object_index"]): parse_pose(m) for m in result["metadata"]}
    urls = mesh_urls(result, len(masks))
    async with httpx.AsyncClient(timeout=DOWNLOAD_TIMEOUT_S, follow_redirects=True) as http:

        async def fetch(url: str | None) -> bytes | None:
            if url is None:
                return None
            response = await http.get(url)
            response.raise_for_status()
            return response.content

        meshes = await asyncio.gather(*(fetch(u) for u in urls))
    return [
        ObjectReconstruction(index=i, glb=glb, pose=poses[i]) if glb is not None and i in poses else None
        for i, glb in enumerate(meshes)
    ]
