import type { ArmInfo } from '../scene/bundle';
import { ArmIk, topDown, type IkResult, type Vec3 } from './ik';
import { objectShape } from './objectShape';
import type { Physics } from './physics';

// Scripted manipulation for the arm: top-down pick, place on another object, put back, home.
// Plans are joint-space waypoints from IK, played back as smooth position targets.

const APPROACH_M = 0.12; // pre-grasp height above the grasp point
const LIFT_M = 0.15;
const TABLE_GAP_M = 0.006; // fingertips stay this far above the surface the object rests on
const TOP_MARGIN_M = 0.012; // grasp at least this far below the object's top
const DROP_GAP_M = 0.012; // release this far above the target surface
const WIDTH_MARGIN_M = 0.012;
const REACH_SLACK_M = 0.02;
const JOINT_SPEED = 0.9; // rad/s for the joint that moves the most
const MIN_MOVE_S = 0.7;
const CLOSE_S = 0.7;
const SETTLE_S = 0.35;
const RELEASE_S = 0.6;
const LIFTED_M = 0.04; // the object has to rise this much for a grasp to count

export type ArmPhase = 'idle' | 'busy' | 'holding';

export interface ArmStatus {
  phase: ArmPhase;
  text: string;
  holding: string | null;
  error: boolean;
}

interface Segment {
  to: number[]; // 7 joint targets + gripper opening
  duration: number;
  onDone?: () => void;
}

interface Shape {
  center: Vec3;
  bottom: number;
  top: number;
  yaw: number; // direction of the narrowest horizontal extent
  width: number; // extent along yaw
  distance: number; // horizontal distance from the arm's base axis
}

interface Held {
  name: string;
  gripToBottom: number; // grasp point height above the object's bottom
  origin: Vec3; // where it was picked: xy and bottom height
  yaw: number; // direction the fingers closed along when it was picked
}

const minJerk = (s: number): number => s * s * s * (10 - 15 * s + 6 * s * s);

export class ArmController {
  private readonly ik: ArmIk;
  private readonly actuators: number[];
  private readonly baseBody: number;
  private queue: Segment[] = [];
  private active: { segment: Segment; from: number[]; start: number } | null = null;
  private target: number[] = [];
  private held: Held | null = null;
  private current: ArmStatus = { phase: 'idle', text: 'Ready', holding: null, error: false };

  constructor(
    private readonly physics: Physics,
    private readonly arm: ArmInfo,
    private readonly labels: ReadonlyMap<string, string>,
    private readonly onStatus: (status: ArmStatus) => void,
  ) {
    const { mujoco, model } = physics;
    this.ik = new ArmIk(physics, arm);
    const names = [...arm.joints, arm.gripper.actuator];
    this.actuators = names.map((name) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR.value, name));
    if (this.actuators.some((a) => a < 0)) throw new Error('scene.xml is missing arm actuators');
    this.baseBody = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, arm.base);
    this.reset();
  }

  get status(): ArmStatus {
    return this.current;
  }

  /** Forget plans and grasps; take the targets the simulation was reset to. */
  reset(): void {
    this.queue = [];
    this.active = null;
    this.held = null;
    const ctrl = this.physics.data.ctrl;
    this.target = this.actuators.map((a) => ctrl[a]);
    this.setStatus('idle', 'Ready');
  }

  /** Called before every physics step: drive the actuators along the current segment. */
  update(): void {
    const time = this.physics.data.time;
    if (!this.active) {
      const next = this.queue.shift();
      if (!next) return;
      this.active = { segment: next, from: this.target.slice(), start: time };
    }
    const { segment, from, start } = this.active;
    const s = Math.min((time - start) / segment.duration, 1);
    const k = minJerk(s);
    const ctrl = this.physics.data.ctrl;
    this.actuators.forEach((a, i) => {
      ctrl[a] = from[i] + (segment.to[i] - from[i]) * k;
    });
    if (s >= 1) {
      this.target = segment.to.slice();
      this.active = null;
      segment.onDone?.();
    }
  }

  pick(name: string): void {
    if (!this.ready()) return;
    if (this.held) {
      this.fail(`Already holding ${this.label(this.held.name)}`);
      return;
    }
    const shape = this.shapeOf(name);
    const problem = this.reachProblem(shape) ?? this.widthProblem(shape);
    if (problem) {
      this.fail(`${this.label(name)}: ${problem}`);
      return;
    }
    const tipBelow = this.arm.gripper.tip_below_grip;
    const graspZ = Math.max(shape.bottom + tipBelow + TABLE_GAP_M, Math.min((shape.bottom + shape.top) / 2, shape.top - TOP_MARGIN_M));
    const [x, y] = shape.center;
    const plan = this.planVertical([x, y, graspZ], [APPROACH_M, 0, LIFT_M], [shape.yaw, shape.yaw + Math.PI]);
    if (!plan) {
      this.fail(`${this.label(name)}: no grasp the arm can reach`);
      return;
    }
    const [above, at, lift] = plan;
    const open = this.arm.gripper.open;
    const startZ = this.bodyZ(name);
    const grip = this.ik.pose(at).rotation;
    const yaw = Math.atan2(grip[4], grip[1]);
    this.enqueue(above, open);
    this.enqueue(at, open);
    this.queue.push({ to: [...at, 0], duration: CLOSE_S }, { to: [...at, 0], duration: SETTLE_S });
    this.enqueue(lift, 0, () => {
      if (this.bodyZ(name) - startZ < LIFTED_M) {
        this.enqueue(this.arm.home, open, () => this.fail(`Missed ${this.label(name)}: it slipped out of the fingers`));
        return;
      }
      this.held = { name, gripToBottom: graspZ - shape.bottom, origin: [x, y, shape.bottom], yaw };
      this.setStatus('holding', `Holding ${this.label(name)}`);
    });
    this.setStatus('busy', `Picking up ${this.label(name)}`);
  }

  /** Put the held object on top of another one. */
  placeOn(name: string): void {
    if (!this.ready() || !this.held) return;
    const shape = this.shapeOf(name);
    const problem = this.reachProblem(shape);
    if (problem) {
      this.fail(`${this.label(name)}: ${problem}`);
      return;
    }
    this.release([shape.center[0], shape.center[1], shape.top], `on ${this.label(name)}`);
  }

  /** Put the held object back where it was picked up. */
  putBack(): void {
    if (!this.ready() || !this.held) return;
    this.release(this.held.origin, 'back');
  }

  /** Release the held object with the grip point over (x, y), on the surface it was picked from,
   * turned by yawDelta (radians) from the heading it was picked with. */
  placeAt(x: number, y: number, yawDelta = 0): void {
    if (!this.ready() || !this.held) return;
    const where = `at (${x.toFixed(2)}, ${y.toFixed(2)})`;
    this.release([x, y, this.held.origin[2]], where, this.held.yaw + yawDelta);
  }

  goHome(): void {
    if (!this.ready()) return;
    const grip = this.target[7];
    this.enqueue(this.arm.home, grip, () =>
      this.setStatus(this.held ? 'holding' : 'idle', this.held ? `Holding ${this.label(this.held.name)}` : 'Ready'),
    );
    this.setStatus('busy', 'Going home');
  }

  dispose(): void {
    this.ik.dispose();
  }

  /** `yaw`: finger direction to release with (exactly, unless only the turned-around grasp reaches);
   * by default the current one. */
  private release(surface: Vec3, where: string, yaw?: number): void {
    const held = this.held!;
    const z = surface[2] + held.gripToBottom + DROP_GAP_M;
    const point: Vec3 = [surface[0], surface[1], z];
    const heights: [number, number, number] = [APPROACH_M, 0, APPROACH_M];
    let plan: number[][] | null;
    if (yaw === undefined) {
      const rotation = this.ik.pose(this.target).rotation;
      const current = Math.atan2(rotation[4], rotation[1]); // keep the object's heading
      plan = this.planVertical(point, heights, [current, current + Math.PI]);
    } else {
      plan = this.planVertical(point, heights, [yaw]) ?? this.planVertical(point, heights, [yaw + Math.PI]);
    }
    const name = this.label(held.name);
    if (!plan) {
      this.fail(`Can't put ${name} ${where}: out of reach`);
      return;
    }
    const [above, at, retreat] = plan;
    const open = this.arm.gripper.open;
    this.enqueue(above, 0);
    this.enqueue(at, 0);
    this.queue.push({ to: [...at, open], duration: RELEASE_S, onDone: () => (this.held = null) });
    this.enqueue(retreat, open);
    this.enqueue(this.arm.home, open, () => this.setStatus('idle', `Put ${name} ${where}`));
    this.setStatus('busy', `Putting ${name} ${where}`);
  }

  /** IK for a point and offsets straight above it; the first yaw whose three poses all solve. */
  private planVertical(point: Vec3, heights: [number, number, number], yaws: number[]): number[][] | null {
    let best: { qs: number[][]; travel: number } | null = null;
    for (const yaw of yaws) {
      const rotation = topDown(yaw);
      const qs: number[][] = [];
      let seed: readonly number[] = this.target.slice(0, 7);
      let ok = true;
      for (const dz of heights) {
        const result: IkResult = this.ik.solve([point[0], point[1], point[2] + dz], rotation, seed);
        if (!result.ok) {
          ok = false;
          break;
        }
        qs.push(result.q);
        seed = result.q;
      }
      if (!ok) continue;
      const travel = qs[0].reduce((s, v, i) => s + Math.abs(v - this.target[i]), 0);
      if (!best || travel < best.travel) best = { qs, travel };
    }
    return best?.qs ?? null;
  }

  private enqueue(q: readonly number[], grip: number, onDone?: () => void): void {
    const from = this.queue.length > 0 ? this.queue[this.queue.length - 1].to : this.target;
    const travel = Math.max(...q.map((v, i) => Math.abs(v - from[i])));
    this.queue.push({ to: [...q, grip], duration: Math.max(MIN_MOVE_S, travel / JOINT_SPEED), onDone });
  }

  private ready(): boolean {
    return this.current.phase !== 'busy';
  }

  private reachProblem(shape: Shape): string | null {
    const [min, max] = this.arm.reach_m;
    const d = shape.distance;
    if (d > max + REACH_SLACK_M) return `out of reach (${d.toFixed(2)} m away, reach ${min.toFixed(2)}–${max.toFixed(2)} m)`;
    if (d < min - REACH_SLACK_M) return `too close to the base (${d.toFixed(2)} m)`;
    return null;
  }

  private widthProblem(shape: Shape): string | null {
    const max = this.arm.gripper.max_width - WIDTH_MARGIN_M;
    return shape.width > max ? `${(shape.width * 100).toFixed(1)} cm wide, the gripper opens to ${(this.arm.gripper.max_width * 100).toFixed(0)} cm` : null;
  }

  private bodyZ(name: string): number {
    const { mujoco, model, data } = this.physics;
    const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
    return data.xpos[body * 3 + 2];
  }

  /** The object's collider (its convex hull) as it is now, and how far it is from the base axis. */
  private shapeOf(name: string): Shape {
    const shape = objectShape(this.physics, name);
    const base = this.physics.data.xpos.subarray(this.baseBody * 3, this.baseBody * 3 + 3);
    return { ...shape, distance: Math.hypot(shape.center[0] - base[0], shape.center[1] - base[1]) };
  }

  private label(name: string): string {
    return this.labels.get(name) ?? name;
  }

  private fail(text: string): void {
    this.setStatus(this.held ? 'holding' : 'idle', text, true);
  }

  private setStatus(phase: ArmPhase, text: string, error = false): void {
    this.current = { phase, text, holding: this.held?.name ?? null, error };
    this.onStatus(this.current);
  }
}
