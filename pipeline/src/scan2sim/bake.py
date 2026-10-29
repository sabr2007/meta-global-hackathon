"""Vertex colours from the hero photo: what the camera saw of an object replaces SAM 3D's guess.

SAM 3D generates the whole texture, the side the photo shows included, and its colours drift: on our
desk the orange figurine came out red and the white keyboard and laptop grey-blue (CIE76 15-19 from
the photo). Every vertex the photo shows head-on inside the object's mask takes the photo's colour;
the others keep SAM 3D's colours shifted (in CIELAB) by the mean difference between the photo and
SAM 3D on the photographed vertices, so the hidden side matches the visible one.
"""

from __future__ import annotations

import numpy as np
import trimesh

from scan2sim.color import lab_to_srgb, srgb_to_lab
from scan2sim.hero import PhotoCamera
from scan2sim.lift import erode
from scan2sim.object_mesh import surface_samples

BAKE_ERODE_PX = 2  # stay off the mask border, where photo pixels mix object and background
FACING_MIN = 0.15  # cosine of the view angle below which the photo smears across the surface
FACING_FULL = 0.45  # ...and above which the photo colour is used as is (blended in between)
MIN_ANCHORS = 20  # photographed vertices needed before the hidden side is colour-matched


def bake_photo_colors(mesh_world: trimesh.Trimesh, camera: PhotoCamera, photo: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """(N, 4) uint8 vertex colours: the photo where it shows the mesh, colour-matched SAM 3D elsewhere.

    `mesh_world` is placed where the photo sees it, `photo` is the (H, W, 3) hero image and `mask`
    the object's full-frame mask raster in it."""
    vertices = np.asarray(mesh_world.vertices, dtype=np.float64)
    original = np.asarray(mesh_world.visual.vertex_colors)[:, :3].astype(np.float64)
    pixels, _ = camera.project(vertices)
    px = np.clip(np.round(pixels).astype(np.int64), 0, [camera.width - 1, camera.height - 1])
    shown = camera.seen(vertices, surface_samples(mesh_world)) & erode(mask, BAKE_ERODE_PX)[px[:, 1], px[:, 0]]
    head_on = np.clip((camera.facing(vertices, mesh_world.vertex_normals) - FACING_MIN) / (FACING_FULL - FACING_MIN), 0.0, 1.0)
    weight = np.where(shown, head_on, 0.0)[:, None]
    photographed = photo[px[:, 1], px[:, 0], :3].astype(np.float64)
    anchors = weight[:, 0] > 0.5
    corrected = original
    if anchors.sum() >= MIN_ANCHORS:
        shift = srgb_to_lab(photographed[anchors]).mean(axis=0) - srgb_to_lab(original[anchors]).mean(axis=0)
        corrected = lab_to_srgb(srgb_to_lab(original) + shift)
    baked = weight * photographed + (1.0 - weight) * corrected
    return np.column_stack([np.round(baked).astype(np.uint8), np.full(len(vertices), 255, dtype=np.uint8)])
