import type { DoubleBuffer, MjData } from '@mujoco/mujoco';
import type { ArmInfo } from '../scene/bundle';
import type { Physics } from './physics';

// Damped least-squares IK for the arm's grip point, position + orientation, with a pull towards
// the home posture in the null space. Same algorithm as pipeline/src/scan2sim/ik.py.
// Kinematics run on a scratch copy of the live state (so a moved arm base is followed); a planner
// can override joints outside the arm, e.g. solve for a mobile base parked somewhere else.

const DAMPING = 0.05;
const ROTATION_WEIGHT = 0.3; // metres of position error worth one radian of orientation error
const NULLSPACE_GAIN = 0.05;
const MAX_STEP = 0.2; // rad per iteration
const ITERATIONS = 300;
const POSITION_TOLERANCE = 0.002;
const ROTATION_TOLERANCE = (2 * Math.PI) / 180;
const DOF = 7;
const TASK = 6;

export type Vec3 = readonly [number, number, number];
/** Row-major 3x3 rotation. */
export type Mat3 = readonly number[];

export interface IkResult {
  q: number[];
  positionError: number;
  rotationError: number;
  ok: boolean;
}

/** Grip frame pointing straight down, fingers closing along the horizontal direction `yaw`. */
export function topDown(yaw: number): Mat3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // columns: x = y × z, y = (c, s, 0), z = (0, 0, -1)
  return [-s, c, 0, c, s, 0, 0, 0, -1];
}

function rotationError(current: ArrayLike<number>, target: Mat3): [number, number, number] {
  const e: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    const a = [current[i], current[3 + i], current[6 + i]];
    const b = [target[i], target[3 + i], target[6 + i]];
    e[0] += 0.5 * (a[1] * b[2] - a[2] * b[1]);
    e[1] += 0.5 * (a[2] * b[0] - a[0] * b[2]);
    e[2] += 0.5 * (a[0] * b[1] - a[1] * b[0]);
  }
  return e;
}

/** Inverse of a small dense matrix (Gauss-Jordan, partial pivoting). */
function invert(n: number, matrix: number[]): number[] {
  const a = matrix.slice();
  const inv: number[] = Array.from({ length: n * n }, (_, k) => (k % (n + 1) === 0 ? 1 : 0));
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(a[r * n + col]) > Math.abs(a[pivot * n + col])) pivot = r;
    for (let k = 0; k < n; k += 1) {
      [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k], a[col * n + k]];
      [inv[col * n + k], inv[pivot * n + k]] = [inv[pivot * n + k], inv[col * n + k]];
    }
    const p = a[col * n + col];
    for (let k = 0; k < n; k += 1) {
      a[col * n + k] /= p;
      inv[col * n + k] /= p;
    }
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = a[r * n + col];
      if (f === 0) continue;
      for (let k = 0; k < n; k += 1) {
        a[r * n + k] -= f * a[col * n + k];
        inv[r * n + k] -= f * inv[col * n + k];
      }
    }
  }
  return inv;
}

export class ArmIk {
  private readonly scratch: MjData;
  private readonly jacp: DoubleBuffer;
  private readonly jacr: DoubleBuffer;
  private readonly qposAdr: number[];
  private readonly dofAdr: number[];
  readonly lower: number[];
  readonly upper: number[];
  private readonly site: number;
  private readonly base: number;
  private readonly home: number[];
  private overrides: [number, number][] = [];

  constructor(
    private readonly physics: Physics,
    arm: ArmInfo,
  ) {
    const { mujoco, model } = physics;
    this.scratch = new mujoco.MjData(model);
    this.jacp = new mujoco.DoubleBuffer(3 * model.nv);
    this.jacr = new mujoco.DoubleBuffer(3 * model.nv);
    const joints = arm.joints.map((name) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name));
    if (joints.some((j) => j < 0)) throw new Error('scene.xml is missing arm joints');
    this.qposAdr = joints.map((j) => model.jnt_qposadr[j]);
    this.dofAdr = joints.map((j) => model.jnt_dofadr[j]);
    this.lower = joints.map((j) => model.jnt_range[j * 2]);
    this.upper = joints.map((j) => model.jnt_range[j * 2 + 1]);
    this.site = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, arm.grip_site);
    this.base = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, arm.base);
    this.home = arm.home.slice();
  }

  /** Solve as if these qpos entries (address, value) had these values, e.g. a planned base pose and
   * lift height; everything else follows the live simulation. An empty list means "as it is now". */
  plannedState(overrides: ReadonlyArray<readonly [number, number]>): void {
    this.overrides = overrides.map(([adr, value]) => [adr, value]);
  }

  private syncScratch(): void {
    const { model, data } = this.physics;
    const qpos = this.scratch.qpos;
    qpos.set(data.qpos);
    if (model.nmocap > 0) {
      this.scratch.mocap_pos.set(data.mocap_pos);
      this.scratch.mocap_quat.set(data.mocap_quat);
    }
    for (const [adr, value] of this.overrides) qpos[adr] = value;
  }

  /** Grip point position and row-major rotation for joint angles q. */
  pose(q: readonly number[]): { position: Vec3; rotation: number[] } {
    const { mujoco, model } = this.physics;
    this.syncScratch();
    const qpos = this.scratch.qpos;
    this.qposAdr.forEach((adr, i) => {
      qpos[adr] = q[i];
    });
    mujoco.mj_kinematics(model, this.scratch);
    mujoco.mj_comPos(model, this.scratch);
    const p = this.scratch.site_xpos.subarray(this.site * 3, this.site * 3 + 3);
    return { position: [p[0], p[1], p[2]], rotation: Array.from(this.scratch.site_xmat.subarray(this.site * 9, this.site * 9 + 9)) };
  }

  /** Home posture with joint 1 turned towards a world point. */
  facing(target: Vec3): number[] {
    this.pose(this.home); // the base pose (live, or planned) in the scratch state
    const pos = this.scratch.xpos;
    const mat = this.scratch.xmat;
    const b = this.base;
    const d = [target[0] - pos[b * 3], target[1] - pos[b * 3 + 1], target[2] - pos[b * 3 + 2]];
    // base frame = xmat^T * d (row-major xmat)
    const x = mat[b * 9] * d[0] + mat[b * 9 + 3] * d[1] + mat[b * 9 + 6] * d[2];
    const y = mat[b * 9 + 1] * d[0] + mat[b * 9 + 4] * d[1] + mat[b * 9 + 7] * d[2];
    const q = this.home.slice();
    q[0] = Math.min(Math.max(Math.atan2(y, x), this.lower[0]), this.upper[0]);
    return q;
  }

  /** Best of a solve from q0 (the current target) and one from home facing the target. */
  solve(position: Vec3, rotation: Mat3, q0?: readonly number[]): IkResult {
    const seeds = q0 ? [q0.slice(), this.facing(position)] : [this.facing(position)];
    const results = seeds.map((seed) => this.solveFrom(position, rotation, seed));
    const cost = (r: IkResult): number => (r.ok ? 0 : 1000) + r.positionError + ROTATION_WEIGHT * r.rotationError;
    return results.reduce((best, r) => (cost(r) < cost(best) ? r : best));
  }

  private solveFrom(position: Vec3, rotation: Mat3, seed: number[]): IkResult {
    const { mujoco, model } = this.physics;
    const nv: number = model.nv;
    const q = seed.map((v, i) => Math.min(Math.max(v, this.lower[i]), this.upper[i]));
    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      const current = this.pose(q);
      const rot = rotationError(current.rotation, rotation);
      const err = [
        position[0] - current.position[0],
        position[1] - current.position[1],
        position[2] - current.position[2],
        ROTATION_WEIGHT * rot[0],
        ROTATION_WEIGHT * rot[1],
        ROTATION_WEIGHT * rot[2],
      ];
      if (Math.hypot(err[0], err[1], err[2]) < POSITION_TOLERANCE && Math.hypot(err[3], err[4], err[5]) < ROTATION_WEIGHT * ROTATION_TOLERANCE) {
        break;
      }
      mujoco.mj_jacSite(model, this.scratch, this.jacp, this.jacr, this.site);
      const jp = this.jacp.GetView();
      const jr = this.jacr.GetView();
      const jac: number[] = new Array(TASK * DOF);
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < DOF; c += 1) {
          jac[r * DOF + c] = jp[r * nv + this.dofAdr[c]];
          jac[(r + 3) * DOF + c] = ROTATION_WEIGHT * jr[r * nv + this.dofAdr[c]];
        }
      }
      // pinv = J^T (J J^T + λ² I)^-1
      const jjt: number[] = new Array(TASK * TASK).fill(0);
      for (let r = 0; r < TASK; r += 1) {
        for (let c = 0; c < TASK; c += 1) {
          let sum = r === c ? DAMPING * DAMPING : 0;
          for (let k = 0; k < DOF; k += 1) sum += jac[r * DOF + k] * jac[c * DOF + k];
          jjt[r * TASK + c] = sum;
        }
      }
      const inv = invert(TASK, jjt);
      const pinv: number[] = new Array(DOF * TASK).fill(0);
      for (let r = 0; r < DOF; r += 1) {
        for (let c = 0; c < TASK; c += 1) {
          let sum = 0;
          for (let k = 0; k < TASK; k += 1) sum += jac[k * DOF + r] * inv[k * TASK + c];
          pinv[r * TASK + c] = sum;
        }
      }
      const pull = q.map((v, i) => NULLSPACE_GAIN * (this.home[i] - v));
      // J pull, then step = pinv err + pull - pinv (J pull)
      const jPull = Array.from({ length: TASK }, (_, r) => pull.reduce((s, v, k) => s + jac[r * DOF + k] * v, 0));
      const step = q.map((_, r) => {
        let s = pull[r];
        for (let k = 0; k < TASK; k += 1) s += pinv[r * TASK + k] * (err[k] - jPull[k]);
        return s;
      });
      const scale = Math.max(1, Math.max(...step.map(Math.abs)) / MAX_STEP);
      for (let i = 0; i < DOF; i += 1) q[i] = Math.min(Math.max(q[i] + step[i] / scale, this.lower[i]), this.upper[i]);
    }
    const final = this.pose(q);
    const positionError = Math.hypot(
      position[0] - final.position[0],
      position[1] - final.position[1],
      position[2] - final.position[2],
    );
    const rotationErr = Math.hypot(...rotationError(final.rotation, rotation));
    return {
      q,
      positionError,
      rotationError: rotationErr,
      ok: positionError < POSITION_TOLERANCE * 2 && rotationErr < ROTATION_TOLERANCE * 2,
    };
  }

  dispose(): void {
    this.jacp.delete();
    this.jacr.delete();
    this.scratch.delete();
  }
}
