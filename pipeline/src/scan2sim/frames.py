"""Coordinate frames.

The capture app stores everything in ARKit world space: meters, +Y up,
right-handed. MuJoCo is +Z up. The simulation world used everywhere
downstream is: +Z up, floor at z = 0, origin at the centre of the floor.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Rotation of +90 degrees about X: ARKit (x, y, z) -> MuJoCo (x, -z, y).
ARKIT_TO_ZUP = np.array(
    [
        [1.0, 0.0, 0.0],
        [0.0, 0.0, -1.0],
        [0.0, 1.0, 0.0],
    ]
)


def mat4_from_column_major(values: list[float]) -> np.ndarray:
    """Parse a simd_float4x4 that was serialised as 16 column-major floats."""
    if len(values) != 16:
        raise ValueError(f"expected 16 values for a 4x4 transform, got {len(values)}")
    return np.asarray(values, dtype=np.float64).reshape(4, 4).T


def quat_from_matrix(rotation: np.ndarray) -> np.ndarray:
    """Rotation matrix -> unit quaternion in MuJoCo order (w, x, y, z)."""
    m = np.asarray(rotation, dtype=np.float64)
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0.0:
        s = 2.0 * np.sqrt(trace + 1.0)
        quat = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
        quat = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
        quat = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = 2.0 * np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
        quat = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    result = np.asarray(quat)
    if result[0] < 0.0:
        result = -result
    return result / np.linalg.norm(result)


def orthonormalize(rotation: np.ndarray) -> np.ndarray:
    """Snap a nearly-orthonormal matrix (float32 noise from the phone) to SO(3)."""
    u, _, vt = np.linalg.svd(rotation)
    fixed = u @ vt
    if np.linalg.det(fixed) < 0.0:
        u = u.copy()
        u[:, -1] = -u[:, -1]
        fixed = u @ vt
    return fixed


@dataclass(frozen=True)
class WorldFrame:
    """Maps ARKit capture coordinates into the simulation world."""

    origin_arkit: np.ndarray  # ARKit point that becomes the world origin (floor centre)

    @classmethod
    def from_matrix(cls, arkit_to_world: np.ndarray) -> WorldFrame:
        """The frame whose `matrix` this is (scene.json stores it as frame.arkit_to_world)."""
        return cls(origin_arkit=-ARKIT_TO_ZUP.T @ np.asarray(arkit_to_world, dtype=np.float64)[:3, 3])

    @property
    def matrix(self) -> np.ndarray:
        """4x4 homogeneous transform ARKit -> world."""
        transform = np.eye(4)
        transform[:3, :3] = ARKIT_TO_ZUP
        transform[:3, 3] = -ARKIT_TO_ZUP @ self.origin_arkit
        return transform

    def points(self, points_arkit: np.ndarray) -> np.ndarray:
        """Transform an (N, 3) array of ARKit points into world points."""
        pts = np.asarray(points_arkit, dtype=np.float64)
        return (pts - self.origin_arkit) @ ARKIT_TO_ZUP.T

    def directions(self, vectors_arkit: np.ndarray) -> np.ndarray:
        """Transform (N, 3) direction vectors (normals) into world directions."""
        return np.asarray(vectors_arkit, dtype=np.float64) @ ARKIT_TO_ZUP.T

    def pose(self, pose_arkit: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """ARKit 4x4 pose -> (world position, world rotation matrix)."""
        position = self.points(pose_arkit[:3, 3][None, :])[0]
        rotation = orthonormalize(ARKIT_TO_ZUP @ pose_arkit[:3, :3])
        return position, rotation
