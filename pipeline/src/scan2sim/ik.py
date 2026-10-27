"""Damped least-squares inverse kinematics for the arm's grip point (position + orientation).

The viewer runs the same algorithm in TypeScript (web/src/sim/ik.ts); this one is used to choose
where the arm stands and by the tests.
"""

from __future__ import annotations

from dataclasses import dataclass

import mujoco
import numpy as np

from scan2sim import arm

DAMPING = 0.05
ROTATION_WEIGHT = 0.3  # metres of position error worth one radian of orientation error
NULLSPACE_GAIN = 0.05  # pull towards the home posture while solving
MAX_STEP = 0.2  # rad per iteration
POSITION_TOLERANCE = 0.002
ROTATION_TOLERANCE = np.radians(2.0)


@dataclass(frozen=True)
class IkResult:
    q: np.ndarray
    position_error: float
    rotation_error: float

    @property
    def ok(self) -> bool:
        return self.position_error < POSITION_TOLERANCE * 2 and self.rotation_error < ROTATION_TOLERANCE * 2


def top_down(yaw: float) -> np.ndarray:
    """Grip frame pointing straight down, fingers closing along the horizontal direction `yaw`."""
    y = np.array([np.cos(yaw), np.sin(yaw), 0.0])
    z = np.array([0.0, 0.0, -1.0])
    return np.column_stack([np.cross(y, z), y, z])


def rotation_error(current: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Axis-angle-like error vector that rotates `current` towards `target` (world frame)."""
    return 0.5 * sum(np.cross(current[:, i], target[:, i]) for i in range(3))


class ArmIk:
    def __init__(self, model: mujoco.MjModel):
        self.model = model
        self.data = mujoco.MjData(model)
        joints = [model.joint(name) for name in arm.JOINT_NAMES]
        self.qpos = np.array([model.jnt_qposadr[j.id] for j in joints])
        self.dofs = np.array([model.jnt_dofadr[j.id] for j in joints])
        self.lower = np.array([j.range[0] for j in joints])
        self.upper = np.array([j.range[1] for j in joints])
        self.site = model.site(arm.GRIP_SITE).id
        self.home = np.array(arm.HOME)

    def pose(self, q: np.ndarray, qpos: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        if qpos is not None:
            self.data.qpos[:] = qpos
        self.data.qpos[self.qpos] = q
        mujoco.mj_kinematics(self.model, self.data)
        mujoco.mj_comPos(self.model, self.data)
        return self.data.site_xpos[self.site].copy(), self.data.site_xmat[self.site].reshape(3, 3).copy()

    def facing(self, position: np.ndarray) -> np.ndarray:
        """Home posture turned (joint 1) towards a world point: a good starting guess."""
        self.pose(self.home)
        base = self.model.body(arm.LINK_NAMES[0]).id
        local = self.data.xmat[base].reshape(3, 3).T @ (np.asarray(position) - self.data.xpos[base])
        q = self.home.copy()
        q[0] = np.clip(np.arctan2(local[1], local[0]), self.lower[0], self.upper[0])
        return q

    def solve(self, position: np.ndarray, rotation: np.ndarray, q0: np.ndarray | None = None) -> IkResult:
        """Best of a solve from q0 (e.g. the current posture) and one from home facing the target."""
        seeds = [self.facing(position)] if q0 is None else [np.asarray(q0, dtype=np.float64), self.facing(position)]
        results = [self._solve(position, rotation, seed) for seed in seeds]
        return min(results, key=lambda r: (not r.ok, r.position_error + ROTATION_WEIGHT * r.rotation_error))

    def _solve(self, position: np.ndarray, rotation: np.ndarray, q0: np.ndarray, iterations: int = 300) -> IkResult:
        q = np.clip(q0, self.lower, self.upper)
        jacp = np.zeros((3, self.model.nv))
        jacr = np.zeros((3, self.model.nv))
        for _ in range(iterations):
            current, frame = self.pose(q)
            error = np.concatenate([position - current, ROTATION_WEIGHT * rotation_error(frame, rotation)])
            if np.linalg.norm(error[:3]) < POSITION_TOLERANCE and np.linalg.norm(error[3:]) < ROTATION_WEIGHT * ROTATION_TOLERANCE:
                break
            mujoco.mj_jacSite(self.model, self.data, jacp, jacr, self.site)
            jac = np.vstack([jacp[:, self.dofs], ROTATION_WEIGHT * jacr[:, self.dofs]])
            pinv = jac.T @ np.linalg.inv(jac @ jac.T + DAMPING**2 * np.eye(6))
            step = pinv @ error + (np.eye(7) - pinv @ jac) @ (NULLSPACE_GAIN * (self.home - q))
            scale = max(1.0, np.abs(step).max() / MAX_STEP)
            q = np.clip(q + step / scale, self.lower, self.upper)
        current, frame = self.pose(q)
        return IkResult(q, float(np.linalg.norm(position - current)), float(np.linalg.norm(rotation_error(frame, rotation))))
