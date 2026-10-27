"""Paid stages for one photo, cached on disk so a scene can be rebuilt without new API calls.

<cache>/verified.pkl          Muse Spark + SAM 3.1 objects (masks) for the photo
<cache>/sam3d/poses.json      SAM 3D poses + a fingerprint of the masks they were made from
<cache>/sam3d/object_<i>.glb  canonical SAM 3D meshes
"""

from __future__ import annotations

import hashlib
import json
import pickle
from pathlib import Path

import numpy as np

from scan2sim.images import UprightImage, load_upright
from scan2sim.meta_client import MetaSettings, async_client
from scan2sim.perceive import MODEL_MAX_SIDE, perceive_photo
from scan2sim.reconstruct import ObjectPose, ObjectReconstruction, reconstruct_objects
from scan2sim.segmentation import ObjectMask
from scan2sim.verify import VerifiedObject, verify


def masks_fingerprint(masks: list[ObjectMask]) -> str:
    digest = hashlib.sha256()
    for mask in masks:
        digest.update(np.asarray(mask.mask_origin + mask.mask.shape, dtype=np.int64).tobytes())
        digest.update(np.packbits(mask.mask).tobytes())
    return digest.hexdigest()[:16]


async def verified_objects(settings: MetaSettings, photo: Path, cache: Path | None) -> tuple[UprightImage, list[VerifiedObject]]:
    """Muse Spark discovery + SAM 3.1 masks + Muse Spark review for one photo."""
    path = cache / "verified.pkl" if cache else None
    if path and path.exists():
        blob = pickle.loads(path.read_bytes())
        if blob.get("photo") == photo.name:
            # Same loader and size as perceive_photo, so the masks line up with these pixels.
            return load_upright(photo, max_side=MODEL_MAX_SIDE), blob["verified"]
    perception = await perceive_photo(settings, photo)
    async with async_client(settings) as client:
        verified, report = await verify(client, perception.image, perception.image.data_url(), perception.objects, perception.masks)
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pickle.dumps({"photo": photo.name, "verified": verified, "report": report}))
    return perception.image, verified


def _pose_json(pose: ObjectPose) -> dict:
    return {"rotation_wxyz": pose.rotation_wxyz.tolist(), "translation": pose.translation.tolist(), "scale": pose.scale}


def save_reconstructions(folder: Path, fingerprint: str, reconstructions: list[ObjectReconstruction | None]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    entries = []
    for i, r in enumerate(reconstructions):
        if r is None:
            entries.append(None)
            continue
        (folder / f"object_{i}.glb").write_bytes(r.glb)
        entries.append(_pose_json(r.pose))
    (folder / "poses.json").write_text(json.dumps({"fingerprint": fingerprint, "objects": entries}, indent=1) + "\n")


def load_reconstructions(folder: Path, fingerprint: str) -> list[ObjectReconstruction | None] | None:
    index = folder / "poses.json"
    if not index.exists():
        return None
    data = json.loads(index.read_text())
    if data.get("fingerprint") != fingerprint:
        return None
    return [
        None
        if entry is None
        else ObjectReconstruction(
            index=i,
            glb=(folder / f"object_{i}.glb").read_bytes(),
            pose=ObjectPose(np.asarray(entry["rotation_wxyz"]), np.asarray(entry["translation"]), float(entry["scale"])),
        )
        for i, entry in enumerate(data["objects"])
    ]


async def sam3d_objects(image: UprightImage, masks: list[ObjectMask], cache: Path | None) -> list[ObjectReconstruction | None]:
    """SAM 3D Objects on fal for every mask (one request), reusing cached meshes for the same masks."""
    folder = cache / "sam3d" if cache else None
    fingerprint = masks_fingerprint(masks)
    if folder:
        cached = load_reconstructions(folder, fingerprint)
        if cached is not None:
            return cached
    reconstructions = await reconstruct_objects(image, masks)
    if folder:
        save_reconstructions(folder, fingerprint, reconstructions)
    return reconstructions
