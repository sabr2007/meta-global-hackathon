// The robots Ayna can dispatch, behind one small interface: can you reach this object / this spot,
// and move this object there (a Promise that settles when the robot is done or gives up).

import { objectShape } from '../sim/objectShape';
import type { Physics } from '../sim/physics';
import type { Robot } from '../sim/robot';
import type { SceneGeometry } from '../sim/sceneGeometry';

const NUDGE_STEP_M = 0.01; // a goal projected just off the table edge is moved onto it in 1 cm steps
const NUDGE_MAX_M = 0.06;
const NUDGE_DIRECTIONS = 12;
const FOOTPRINT_SHARE = 0.5; // same share of the footprint the robots check before letting go

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

/** A robot from the scene's registry (web/src/sim/robots.ts) as Ayna dispatches it. Goals are where
 * an object's body origin should land; robots grip the object's footprint centre, so the step is
 * shifted by that offset (turned with the object). */
class RegistryRobot implements FleetRobot {
  readonly kind: 'arm' | 'mobile';
  readonly gripWidthM: number;

  constructor(
    private readonly physics: Physics,
    private readonly robot: Robot,
    private readonly scene: SceneGeometry,
  ) {
    this.kind = robot.kind;
    this.gripWidthM = robot.info.gripper.max_width;
  }

  get id(): string {
    return this.robot.id;
  }

  get label(): string {
    return this.robot.label;
  }

  reachOf(object: string): Reach {
    const r = this.robot.reachOf(object);
    return { ok: r.ok, reason: r.reason, distanceM: r.distance_m };
  }

  reachPoint(x: number, y: number): Reach {
    const r = this.robot.reachPoint(x, y);
    return { ok: r.ok, reason: r.reason, distanceM: r.distance_m };
  }

  /** The goal, or the nearest point within a few centimetres where the object can be put down
   * (goals read off a photo can land just past a table edge). The receipt still measures against the goal. */
  private placeable(x: number, y: number, radius: number, body: number): [number, number] {
    const ok = (px: number, py: number): boolean => typeof this.scene.placeSurface(px, py, radius, body) !== 'string';
    if (ok(x, y)) return [x, y];
    for (let d = NUDGE_STEP_M; d <= NUDGE_MAX_M + 1e-9; d += NUDGE_STEP_M) {
      for (let k = 0; k < NUDGE_DIRECTIONS; k += 1) {
        const a = (2 * Math.PI * k) / NUDGE_DIRECTIONS;
        if (ok(x + d * Math.cos(a), y + d * Math.sin(a))) return [x + d * Math.cos(a), y + d * Math.sin(a)];
      }
    }
    return [x, y];
  }

  async run(step: MoveStep): Promise<StepResult> {
    const { mujoco, model, data } = this.physics;
    const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, step.object);
    const shape = objectShape(this.physics, step.object);
    const ox = shape.center[0] - data.xpos[body * 3];
    const oy = shape.center[1] - data.xpos[body * 3 + 1];
    const c = Math.cos(step.yawDelta);
    const s = Math.sin(step.yawDelta);
    const [gx, gy] = this.placeable(step.x + c * ox - s * oy, step.y + s * ox + c * oy, shape.radius * FOOTPRINT_SHARE, body);
    const result = await this.robot.run({ object: step.object, x: gx, y: gy, yawDelta: step.yawDelta });
    // A robot that could not put the object down at the goal puts it back, so the next step starts free.
    if (!result.ok && this.robot.status.holding) await this.robot.run({ action: 'putBack' });
    return result;
  }

  update(): void {
    this.robot.update();
  }

  reset(): void {
    this.robot.reset();
  }

  status(): string {
    return this.robot.status.text;
  }
}

export function fleetOf(physics: Physics, robots: Robot[], scene: SceneGeometry): FleetRobot[] {
  return robots.map((robot) => new RegistryRobot(physics, robot, scene));
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
