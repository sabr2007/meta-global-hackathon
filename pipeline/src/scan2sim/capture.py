"""Load a `house-capture/5` export (from the 3D Model Anything iPhone app)."""

from __future__ import annotations

import json
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from scan2sim.frames import mat4_from_column_major
from scan2sim.roomplan import Room, parse_room

SUPPORTED_FORMAT = "house-capture/5"
DEPTH_SHAPE = (192, 256)  # rows, cols of the LiDAR depth map
DEPTH_RGB_SIZE = (640, 480)  # width, height of the colour JPEG stored with each depth frame


@dataclass(frozen=True)
class CameraView:
    """A posed image: photo or depth frame."""

    image: Path
    width: int
    height: int
    intrinsics: np.ndarray  # 3x3
    camera_to_world: np.ndarray  # 4x4, ARKit (camera looks down -Z)
    timestamp: float
    hero: bool = False  # the "before" photo the Ayna app asks for after a scan


@dataclass(frozen=True)
class DepthFrame:
    depth: Path  # 256x192 float16 meters, raw DEFLATE
    confidence: Path  # 256x192 uint8 (0..2)
    view: CameraView  # intrinsics of the depth map
    rgb: CameraView  # 640x480 colour image of the same instant


@dataclass(frozen=True)
class CapturedRoom:
    index: int
    name: str
    room: Room
    mesh_ply: Path
    mesh_colors: Path | None


@dataclass(frozen=True)
class Capture:
    root: Path
    manifest: dict[str, Any]
    rooms: tuple[CapturedRoom, ...]
    photos: tuple[CameraView, ...]
    depth_frames: tuple[DepthFrame, ...]


def _mat3_from_column_major(values: list[float]) -> np.ndarray:
    if len(values) != 9:
        raise ValueError(f"expected 9 intrinsics values, got {len(values)}")
    return np.asarray(values, dtype=np.float64).reshape(3, 3).T


def _view(root: Path, image: str, raw: dict[str, Any], intrinsics_key: str, size: tuple[int, int]) -> CameraView:
    return CameraView(
        image=root / image,
        width=size[0],
        height=size[1],
        intrinsics=_mat3_from_column_major(raw[intrinsics_key]),
        camera_to_world=mat4_from_column_major(raw["transform"]),
        timestamp=float(raw["timestamp"]),
        hero=bool(raw.get("hero", False)),
    )


def find_capture_root(path: Path) -> Path:
    """Accept the session folder itself or any folder that contains exactly one manifest."""
    path = Path(path)
    if (path / "manifest.json").exists():
        return path
    manifests = sorted(path.rglob("manifest.json"))
    if len(manifests) != 1:
        raise FileNotFoundError(f"expected one manifest.json under {path}, found {len(manifests)}")
    return manifests[0].parent


def extract_zip(zip_path: Path, destination: Path) -> Path:
    """Unpack an exported .zip, refusing entries that escape the destination."""
    destination = Path(destination).resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            target = (destination / member).resolve()
            if destination not in target.parents and target != destination:
                raise ValueError(f"unsafe path in archive: {member}")
        archive.extractall(destination)
    return find_capture_root(destination)


def load_capture(path: Path) -> Capture:
    root = find_capture_root(path)
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest.get("format") != SUPPORTED_FORMAT:
        raise ValueError(f"unsupported capture format {manifest.get('format')!r}, expected {SUPPORTED_FORMAT}")

    rooms = []
    for entry in manifest.get("rooms", []):
        mesh_ply = root / entry["mesh"]["file"]
        colors = mesh_ply.with_name(mesh_ply.stem + "-colors.bin")
        rooms.append(
            CapturedRoom(
                index=int(entry["index"]),
                name=str(entry.get("name", f"room-{entry['index']}")),
                room=parse_room(json.loads((root / entry["file"]).read_text())),
                mesh_ply=mesh_ply,
                mesh_colors=colors if colors.exists() else None,
            )
        )
    if not rooms:
        raise ValueError("capture contains no rooms")

    photos = tuple(
        _view(root, p["file"], p, "intrinsics", (int(p["width"]), int(p["height"])))
        for p in json.loads((root / manifest["photos"]).read_text())
    )
    depth_frames = []
    for f in json.loads((root / manifest["depthFrames"]).read_text()):
        depth_frames.append(
            DepthFrame(
                depth=root / f["file"],
                confidence=root / f["confidence"],
                view=_view(root, f["file"], f, "intrinsics", (int(f["width"]), int(f["height"]))),
                rgb=_view(root, f["rgb"], f, "rgbIntrinsics", DEPTH_RGB_SIZE),
            )
        )

    return Capture(
        root=root,
        manifest=manifest,
        rooms=tuple(rooms),
        photos=photos,
        depth_frames=tuple(depth_frames),
    )


def read_depth(frame: DepthFrame) -> tuple[np.ndarray, np.ndarray]:
    """Return (depth in meters as float32, confidence 0..2) for one depth frame."""
    raw = zlib.decompress(frame.depth.read_bytes(), -15)
    depth = np.frombuffer(raw, dtype="<f2").reshape(DEPTH_SHAPE).astype(np.float32)
    confidence = np.fromfile(frame.confidence, dtype=np.uint8).reshape(DEPTH_SHAPE)
    return depth, confidence
