// The robots Ayna can dispatch, behind one small interface: can you reach this object / this spot,
// and move this object there (a Promise that settles when the robot is done or gives up).

import { objectShape, type ObjectShape } from '../sim/objectShape';
import type { Physics } from '../sim/physics';
import type { Robot } from '../sim/robot';
import { PLACE_HEADROOM_M, spoken, type SceneGeometry } from '../sim/sceneGeometry';

const NUDGE_STEP_M = 0.01; // a goal projected just off the table edge is moved onto it in 1 cm steps
const NUDGE_MAX_M = 0.06;
const NUDGE_FEASIBLE_M = 0.02; // a version whose goal must move further than this would miss the 3 cm tolerance: redraw it instead
const NUDGE_DIRECTIONS = 12;
const FOOTPRINT_SHARE = 0.5; // same share of the footprint the robots check before letting go
const SAME_SURFACE_M = 0.015; // goals are read on the object's own table: a spot lower or higher (the floor past its edge) is off it

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
  /** Can it put something down at (x, y)? With `object`, the exact test for that object's footprint. */
  /** Can this robot put something down at (x, y)? With an object (and its turn), the exact put-down test. */
  reachPoint(x: number, y: number, object?: string, yawDelta?: number): Reach;
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

  reachPoint(x: number, y: number, object?: string, yawDelta = 0): Reach {
    let [px, py] = [x, y];
    if (object) {
      const landing = this.landing(object, x, y, yawDelta);
      [px, py] = landing.point;
      const surface = this.scene.placeSurface(px, py, landing.shape.radius * FOOTPRINT_SHARE, landing.body, landing.shape.bottom + PLACE_HEADROOM_M);
      if (typeof surface === 'string') return { ok: false, reason: `can't put it down there: ${surface}`, distanceM: 0 };
      if (!surface.object && Math.abs(surface.z - landing.shape.bottom) > SAME_SURFACE_M) {
        return { ok: false, reason: `can't put it down there: (${px.toFixed(2)}, ${py.toFixed(2)}) is off ${spoken(surface.name)} it stands on`, distanceM: 0 };
      }
      if (landing.nudgedM > NUDGE_FEASIBLE_M) {
        return { ok: false, reason: `can't put it down there: the spot is ${(landing.nudgedM * 100).toFixed(0)} cm past the edge of ${spoken(surface.name)}`, distanceM: 0 };
      }
    }
    const r = this.robot.reachPoint(px, py);
    return { ok: r.ok, reason: r.reason, distanceM: r.distance_m };
  }

  /** Where the gripped footprint centre goes when the object's body origin should land at (x, y)
   * turned by yawDelta, nudged back onto the object's own surface when that lands just past an edge. */
  private landing(object: string, x: number, y: number, yawDelta: number): { point: [number, number]; nudgedM: number; body: number; shape: ObjectShape } {
    const { mujoco, model, data } = this.physics;
    const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, object);
    const shape = objectShape(this.physics, object);
    const ox = shape.center[0] - data.xpos[body * 3];
    const oy = shape.center[1] - data.xpos[body * 3 + 1];
    const c = Math.cos(yawDelta);
    const s = Math.sin(yawDelta);
    const wanted: [number, number] = [x + c * ox - s * oy, y + s * ox + c * oy];
    const point = this.placeable(wanted[0], wanted[1], shape.radius * FOOTPRINT_SHARE, body, shape.bottom);
    return { point, nudgedM: Math.hypot(point[0] - wanted[0], point[1] - wanted[1]), body, shape };
  }

  /** The goal, or the nearest point within a few centimetres where the object can be put down
   * (goals read off a photo can land just past a table edge). The receipt still measures against the goal. */
  private placeable(x: number, y: number, radius: number, body: number, bottom: number): [number, number] {
    const ok = (px: number, py: number): boolean => {
      const surface = this.scene.placeSurface(px, py, radius, body, bottom + PLACE_HEADROOM_M);
      return typeof surface !== 'string' && (Boolean(surface.object) || Math.abs(surface.z - bottom) <= SAME_SURFACE_M);
    };
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
    const [gx, gy] = this.landing(step.object, step.x, step.y, step.yawDelta).point;
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
