// The robots Ayna can dispatch, behind one small interface: can you reach this object / this spot,
// and move this object there (a Promise that settles when the robot is done or gives up).

import type { ArmInfo } from '../scene/bundle';
import { ArmController, type ArmStatus } from '../sim/armController';
import type { Physics } from '../sim/physics';

const WIDTH_MARGIN_M = 0.012; // same margin the arm controller keeps around the fingers
const REACH_SLACK_M = 0.02;
const STEP_TIMEOUT_S = 40; // simulated seconds before a step counts as stuck

export interface Reach {
  ok: boolean;
  reason: string;
  distanceM: number;
}

export interface MoveStep {
  object: string;
  x: number; // where the object's body origin should end up
  y: number;
  yawDelta: number;
}

export interface StepResult {
  ok: boolean;
  reason: string;
}

export interface FleetRobot {
  readonly id: string;
  readonly kind: 'arm' | 'mobile';
  readonly label: string;
  readonly gripWidthM: number;
  reachOf(object: string): Reach;
  reachPoint(x: number, y: number): Reach;
  run(step: MoveStep): Promise<StepResult>;
  /** Called before every physics step. */
  update(): void;
  reset(): void;
  status(): string;
}

export interface ObjectShape {
  name: string;
  label: string;
  size_m: [number, number, number];
}

/** Our 7-DoF arm on the table (ArmController) as a fleet robot. */
export class ArmRobot implements FleetRobot {
  readonly kind = 'arm' as const;
  readonly gripWidthM: number;
  private readonly controller: ArmController;
  private readonly shapes: Map<string, ObjectShape>;
  private waiter: ((status: ArmStatus) => void) | null = null;
  private last: ArmStatus | null = null;

  constructor(
    private readonly physics: Physics,
    private readonly info: ArmInfo,
    objects: ObjectShape[],
    readonly id = 'arm',
    readonly label = 'Arm',
  ) {
    this.shapes = new Map(objects.map((o) => [o.name, o]));
    this.gripWidthM = info.gripper.max_width;
    const labels = new Map(objects.map((o) => [o.name, o.label]));
    this.controller = new ArmController(physics, info, labels, (status) => {
      this.last = status;
      this.waiter?.(status);
    });
  }

  private base(): [number, number] {
    const { mujoco, model, data } = this.physics;
    const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, this.info.base);
    return [data.xpos[body * 3], data.xpos[body * 3 + 1]];
  }

  private bodyXY(name: string): [number, number] {
    const { mujoco, model, data } = this.physics;
    const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
    return [data.xpos[body * 3], data.xpos[body * 3 + 1]];
  }

  reachPoint(x: number, y: number): Reach {
    const [bx, by] = this.base();
    const distanceM = Math.hypot(x - bx, y - by);
    const [min, max] = this.info.reach_m;
    if (distanceM > max + REACH_SLACK_M) return { ok: false, reason: `${distanceM.toFixed(2)} m away, reach ${max.toFixed(2)} m`, distanceM };
    if (distanceM < min - REACH_SLACK_M) return { ok: false, reason: `${distanceM.toFixed(2)} m from the base, too close`, distanceM };
    return { ok: true, reason: `${distanceM.toFixed(2)} m away`, distanceM };
  }

  reachOf(object: string): Reach {
    const [x, y] = this.bodyXY(object);
    const reach = this.reachPoint(x, y);
    const shape = this.shapes.get(object);
    const narrow = shape ? Math.min(shape.size_m[0], shape.size_m[1]) : 0;
    if (reach.ok && narrow > this.gripWidthM - WIDTH_MARGIN_M) {
      return { ok: false, reason: `${(narrow * 100).toFixed(1)} cm wide, gripper opens to ${(this.gripWidthM * 100).toFixed(0)} cm`, distanceM: reach.distanceM };
    }
    return reach;
  }

  /** Start an action and wait until the controller reports a status that settles it. */
  private act(start: () => void, settled: (status: ArmStatus) => boolean): Promise<ArmStatus> {
    return new Promise((resolve) => {
      const deadline = this.physics.time() + STEP_TIMEOUT_S;
      this.waiter = (status) => {
        if (settled(status) || this.physics.time() > deadline) {
          this.waiter = null;
          resolve(status);
        }
      };
      start();
      // An action that fails up front reports synchronously and never goes busy.
      if (this.waiter && this.last && this.last.phase !== 'busy' && this.last.error) {
        this.waiter = null;
        resolve(this.last);
      }
    });
  }

  async run(step: MoveStep): Promise<StepResult> {
    this.last = null;
    const picked = await this.act(
      () => this.controller.pick(step.object),
      (s) => s.phase !== 'busy',
    );
    if (picked.phase !== 'holding') return { ok: false, reason: picked.text };
    this.last = null;
    const placed = await this.act(
      () => this.controller.placeAt(step.x, step.y, step.yawDelta),
      (s) => s.phase !== 'busy',
    );
    if (placed.error || placed.phase === 'holding') {
      // Could not put it at the goal: put it back where it was rather than hold it forever.
      this.last = null;
      await this.act(
        () => this.controller.putBack(),
        (s) => s.phase !== 'busy',
      );
      return { ok: false, reason: placed.text };
    }
    return { ok: true, reason: placed.text };
  }

  update(): void {
    this.controller.update();
  }

  reset(): void {
    this.controller.reset();
  }

  status(): string {
    return this.controller.status.text;
  }
}

/** Drive physics until every promise in `work` settles (Node: eval and tests; the browser uses its frame loop). */
export async function runHeadless<T>(physics: Physics, robots: FleetRobot[], work: Promise<T>, maxSeconds = 600): Promise<T> {
  let done = false;
  const result = work.finally(() => {
    done = true;
  });
  const end = physics.time() + maxSeconds;
  while (!done && physics.time() < end) {
    physics.advance(0.05, () => robots.forEach((r) => r.update()));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let settled steps chain the next one
  }
  return result;
}
