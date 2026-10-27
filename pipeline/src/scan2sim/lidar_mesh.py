"""Read the capture app's LiDAR mesh (binary PLY with per-face semantic class)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

FACE_CLASSES = ("none", "wall", "floor", "ceiling", "table", "seat", "window", "door")

_VERTEX_DTYPE = np.dtype(
    [
        ("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
        ("nx", "<f4"), ("ny", "<f4"), ("nz", "<f4"),
        ("coverage", "<f4"),
        ("red", "u1"), ("green", "u1"), ("blue", "u1"),
        ("inroom", "u1"),
    ]
)
# Every face is a triangle: list count (uchar) + 3 uint indices + class (uchar).
_FACE_DTYPE = np.dtype([("count", "u1"), ("indices", "<u4", (3,)), ("cls", "u1")])

_EXPECTED_VERTEX_PROPS = [name for name in _VERTEX_DTYPE.names]


@dataclass(frozen=True)
class LidarMesh:
    """Mesh in ARKit coordinates."""

    vertices: np.ndarray  # (V, 3) float64
    normals: np.ndarray  # (V, 3) float64
    colors: np.ndarray  # (V, 3) uint8
    in_room: np.ndarray  # (V,) bool
    faces: np.ndarray  # (F, 3) int64
    face_class: np.ndarray  # (F,) uint8, index into FACE_CLASSES


def _read_header(data: bytes) -> tuple[int, int, int]:
    """Return (vertex count, face count, offset of the binary body)."""
    marker = b"end_header\n"
    end = data.find(marker)
    if end < 0:
        raise ValueError("not a PLY file: missing end_header")
    lines = data[:end].decode("ascii").splitlines()
    if lines[0] != "ply" or "binary_little_endian" not in lines[1]:
        raise ValueError("expected a binary little-endian PLY")
    counts: dict[str, int] = {}
    vertex_props: list[str] = []
    current = None
    for line in lines:
        parts = line.split()
        if parts[:1] == ["element"]:
            current = parts[1]
            counts[current] = int(parts[2])
        elif parts[:1] == ["property"] and current == "vertex":
            vertex_props.append(parts[-1])
    if vertex_props != _EXPECTED_VERTEX_PROPS:
        raise ValueError(f"unexpected vertex layout {vertex_props}, expected {_EXPECTED_VERTEX_PROPS}")
    return counts["vertex"], counts["face"], end + len(marker)


def read_lidar_mesh(ply_path: Path, colors_path: Path | None = None) -> LidarMesh:
    """Read mesh/room-N.ply; optionally use photo colours from mesh/room-N-colors.bin."""
    data = Path(ply_path).read_bytes()
    n_vertices, n_faces, offset = _read_header(data)
    vertex_bytes = n_vertices * _VERTEX_DTYPE.itemsize
    verts = np.frombuffer(data, dtype=_VERTEX_DTYPE, count=n_vertices, offset=offset)
    faces = np.frombuffer(data, dtype=_FACE_DTYPE, count=n_faces, offset=offset + vertex_bytes)
    if np.any(faces["count"] != 3):
        raise ValueError("only triangle meshes are supported")

    colors = np.stack([verts["red"], verts["green"], verts["blue"]], axis=1)
    if colors_path is not None and Path(colors_path).exists():
        photo_colors = np.fromfile(colors_path, dtype=np.uint8)
        if photo_colors.size == n_vertices * 3:
            colors = photo_colors.reshape(n_vertices, 3)

    return LidarMesh(
        vertices=np.stack([verts["x"], verts["y"], verts["z"]], axis=1).astype(np.float64),
        normals=np.stack([verts["nx"], verts["ny"], verts["nz"]], axis=1).astype(np.float64),
        colors=np.ascontiguousarray(colors),
        in_room=verts["inroom"].astype(bool),
        faces=faces["indices"].astype(np.int64),
        face_class=faces["cls"].copy(),
    )
