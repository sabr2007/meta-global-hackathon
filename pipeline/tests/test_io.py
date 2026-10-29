import zipfile
import zlib

import numpy as np
import pytest

from scan2sim.capture import DEPTH_SHAPE, CameraView, DepthFrame, extract_zip, read_depth
from scan2sim.lidar_mesh import read_lidar_mesh

PLY_HEADER = """ply
format binary_little_endian 1.0
element vertex {n_vertices}
property float x
property float y
property float z
property float nx
property float ny
property float nz
property float coverage
property uchar red
property uchar green
property uchar blue
property uchar inroom
element face {n_faces}
property list uchar uint vertex_indices
property uchar class
end_header
"""


def _write_ply(path, vertices, faces, classes):
    vertex_rows = np.zeros(
        len(vertices),
        dtype=[("p", "<f4", 3), ("n", "<f4", 3), ("cov", "<f4"), ("rgb", "u1", 3), ("inroom", "u1")],
    )
    vertex_rows["p"] = vertices
    vertex_rows["n"] = [0.0, 1.0, 0.0]
    vertex_rows["rgb"] = [10, 20, 30]
    vertex_rows["inroom"] = 1
    face_rows = np.zeros(len(faces), dtype=[("count", "u1"), ("idx", "<u4", 3), ("cls", "u1")])
    face_rows["count"] = 3
    face_rows["idx"] = faces
    face_rows["cls"] = classes
    header = PLY_HEADER.format(n_vertices=len(vertices), n_faces=len(faces)).encode()
    path.write_bytes(header + vertex_rows.tobytes() + face_rows.tobytes())


def test_reads_mesh_and_prefers_photo_colours(tmp_path):
    ply = tmp_path / "room-0.ply"
    _write_ply(ply, [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], [[0, 1, 2], [1, 3, 2]], [2, 3])
    colors = tmp_path / "room-0-colors.bin"
    np.full(4 * 3, 200, dtype=np.uint8).tofile(colors)

    mesh = read_lidar_mesh(ply, colors)

    assert mesh.vertices.shape == (4, 3)
    assert mesh.faces.tolist() == [[0, 1, 2], [1, 3, 2]]
    assert mesh.face_class.tolist() == [2, 3]
    assert (mesh.colors == 200).all()


def test_rejects_unexpected_vertex_layout(tmp_path):
    ply = tmp_path / "bad.ply"
    ply.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nelement face 0\nend_header\n")
    with pytest.raises(ValueError, match="unexpected vertex layout"):
        read_lidar_mesh(ply)


def test_decodes_raw_deflate_float16_depth(tmp_path):
    depth = np.linspace(0.5, 3.0, DEPTH_SHAPE[0] * DEPTH_SHAPE[1], dtype=np.float16).reshape(DEPTH_SHAPE)
    compressor = zlib.compressobj(wbits=-15)
    (tmp_path / "0.f16z").write_bytes(compressor.compress(depth.tobytes()) + compressor.flush())
    np.ones(DEPTH_SHAPE, dtype=np.uint8).tofile(tmp_path / "0.conf")
    view = CameraView(tmp_path / "0.f16z", 256, 192, np.eye(3), np.eye(4), 0.0)
    frame = DepthFrame(depth=tmp_path / "0.f16z", confidence=tmp_path / "0.conf", view=view, rgb=view)

    decoded, confidence = read_depth(frame)

    assert np.allclose(decoded, depth.astype(np.float32))
    assert (confidence == 1).all()


def test_zip_extraction_blocks_path_traversal(tmp_path):
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../escape.txt", "nope")
    with pytest.raises(ValueError, match="unsafe path"):
        extract_zip(archive, tmp_path / "out")



def test_photo_views_carry_the_hero_flag(tmp_path):
    from scan2sim.capture import _view

    raw = {"intrinsics": [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0], "transform": np.eye(4).reshape(-1).tolist(), "timestamp": 1.0}
    assert _view(tmp_path, "photos/0001.jpg", raw, "intrinsics", (4, 3)).hero is False
    assert _view(tmp_path, "photos/0002.jpg", {**raw, "hero": True}, "intrinsics", (4, 3)).hero is True
