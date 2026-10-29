import type { ArmRobotInfo } from '../scene/bundle';
import { ArmController } from './armController';
import { objectShape } from './objectShape';
import type { Physics } from './physics';
import { RobotBase, ok, refused, type BasePose, type ReachCheck, type RobotStatus, type StepResult } from './robot';
import { discOnRect, PLACE_HEADROOM_M, type SceneGeometry } from './sceneGeometry';

// The stationary arm as a Robot: ArmController does the manipulation; this adds the shared API
// (reach checks, run(), placeAt on another surface) and moving its mocap base across the table.

const WIDTH_MARGIN_M = 0.012; // same as ArmController: the fingers need some play around an object
const OBJECT_CLEARANCE_M = 0.02; // between the base and any object when it is put down
const SAME_SURFACE_M = 0.015;
const FOOTPRINT_SHARE = 0.5; // this much of a held object's footprint radius must rest on the surface (goals often group objects closely)
const REACH_SLACK_M = 0.02; // the band is for comfortable top-down grasps; the IK still solves a little past it
const PLACED_HEIGHT_M = 0.03; // after a release the object rests this close to the planned surface
const PLACED_OFFSET_M = 0.06; // ... and this close to the planned point
const LOWEST_REACH_M = -0.1; // objects this far below the base (or higher than HIGHEST) are out of reach
const HIGHEST_REACH_M = 0.35;
const DEFAULT_FOOTPRINT_M = 0.11;

export class StationaryArm extends RobotBase {
  readonly kind = 'arm' as const;
  readonly controller: ArmController;
  private readonly baseBody: number;
  private readonly mocap: number; // index into data.mocap_pos, -1 when the base cannot move
  private home: BasePose; // where reset() puts the base: the last place it was dragged to
  private pickedFrom: number | null = null; // surface height the held object was picked from
  private placing: { name: string; x: number; y: number; z: number } | null = null; // checked when done
  private verdict: RobotStatus | null = null; // overrides the controller's report after a bad placement

  constructor(
    private readonly physics: Physics,
    override readonly info: ArmRobotInfo,
    private readonly scene: SceneGeometry,
    labels: ReadonlyMap<string, string>,
  ) {
    super(info, labels);
    const { mujoco, model } = physics;
    this.baseBody = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, info.base);
    if (this.baseBody < 0) throw new Error(`scene.xml has no body ${info.base}`);
    this.mocap = model.body_mocapid[this.baseBody];
    this.controller = new ArmController(physics, info, labels, (status) => this.onStatus(status));
    this.home = this.basePose();
  }

  get status(): RobotStatus {
    return this.verdict ?? this.controller.status;
  }

  update(): void {
    this.controller.update();
  }

  reset(): void {
    this.abandon('Reset');
    this.pickedFrom = null;
    this.placing = null;
    this.verdict = null;
    if (this.mocap >= 0) this.applyBase(this.home);
    this.controller.reset();
  }

  basePose(): BasePose {
    const { xpos, xmat } = this.physics.data;
    const b = this.baseBody;
    return { x: xpos[b * 3], y: xpos[b * 3 + 1], z: xpos[b * 3 + 2], yaw: Math.atan2(xmat[b * 9 + 3], xmat[b * 9]) };
  }

  reachOf(objectName: string): ReachCheck {
    if (!this.hasObject(objectName)) return { ok: false, reason: `no object named ${objectName}`, distance_m: Infinity };
    const shape = objectShape(this.physics, objectName);
    const base = this.basePose();
    const distance = Math.hypot(shape.center[0] - base.x, shape.center[1] - base.y);
    const [min, max] = this.info.reach_m;
    const problems: string[] = [];
    if (distance > max + REACH_SLACK_M) problems.push(`${distance.toFixed(2)} m away, reach ${max.toFixed(2)} m`);
    else if (distance < min) problems.push(`${distance.toFixed(2)} m away, too close to the base (${min.toFixed(2)} m)`);
    const below = shape.bottom - base.z;
    if (below < LOWEST_REACH_M) problems.push(`${(-below).toFixed(2)} m below the arm's base`);
    else if (below > HIGHEST_REACH_M) problems.push(`${below.toFixed(2)} m above the arm's base`);
    const maxWidth = this.info.gripper.max_width;
    if (shape.width > maxWidth - WIDTH_MARGIN_M) {
      problems.push(`${(shape.width * 100).toFixed(1)} cm wide, needs ${((shape.width + WIDTH_MARGIN_M) * 100).toFixed(1)} cm with clearance, gripper opens ${(maxWidth * 100).toFixed(0)} cm`);
    }
    if (problems.length > 0) return { ok: false, reason: problems.join('; '), distance_m: distance };
    return { ok: true, reason: `${distance.toFixed(2)} m away, within reach`, distance_m: distance };
  }

  reachPoint(x: number, y: number): ReachCheck {
    const base = this.basePose();
    const distance = Math.hypot(x - base.x, y - base.y);
    const [min, max] = this.info.reach_m;
    if (distance > max + REACH_SLACK_M) return { ok: false, reason: `${distance.toFixed(2)} m away, reach ${max.toFixed(2)} m`, distance_m: distance };
    if (distance < min) return { ok: false, reason: `${distance.toFixed(2)} m from the base, too close (${min.toFixed(2)} m)`, distance_m: distance };
    return { ok: true, reason: `${distance.toFixed(2)} m away, within reach`, distance_m: distance };
  }

  pick(objectName: string): StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    if (this.status.holding) return refused(`Already holding ${this.name(this.status.holding)}`);
    if (!this.hasObject(objectName)) return refused(`No object named ${objectName}`);
    this.pickedFrom = objectShape(this.physics, objectName).bottom;
    this.verdict = null;
    this.controller.pick(objectName);
    return this.accepted();
  }

  placeAt(x: number, y: number, yawDelta = 0): StepResult {
    const invalid = this.badNumbers(x, y, yawDelta);
    if (invalid) return invalid;
    const held = this.heldOrRefusal();
    if (typeof held !== 'string') return held;
    const base = this.basePose();
    const distance = Math.hypot(x - base.x, y - base.y);
    const [min, max] = this.info.reach_m;
    if (distance > max + REACH_SLACK_M) return refused(`(${x.toFixed(2)}, ${y.toFixed(2)}) is ${distance.toFixed(2)} m away, reach ${max.toFixed(2)} m`);
    if (distance < min) return refused(`(${x.toFixed(2)}, ${y.toFixed(2)}) is too close to the base`);
    const ceiling = this.pickedFrom === null ? undefined : this.pickedFrom + PLACE_HEADROOM_M;
    const surface = this.scene.placeSurface(x, y, objectShape(this.physics, held).radius * FOOTPRINT_SHARE, this.bodyOf(held), ceiling);
    if (typeof surface === 'string') return refused(`Can't put ${this.name(held)} down: ${surface}`);
    // On top of another object: stack it there; anything else must be the surface it came from.
    if (surface.object) return this.placeOn(surface.object);
    const from = this.pickedFrom ?? surface.z;
    if (Math.abs(surface.z - from) > SAME_SURFACE_M) {
      return refused(`(${x.toFixed(2)}, ${y.toFixed(2)}) is ${surface.z > from ? 'above' : 'below'} the surface ${this.name(held)} came from`);
    }
    this.placing = { name: held, x, y, z: surface.z };
    this.verdict = null;
    this.controller.placeAt(x, y, yawDelta);
    return this.accepted();
  }

  placeOn(objectName: string): StepResult {
    const held = this.heldOrRefusal();
    if (typeof held !== 'string') return held;
    if (!this.hasObject(objectName) || objectName === held) return refused(`Can't put ${this.name(held)} on ${this.name(objectName)}`);
    this.controller.placeOn(objectName);
    return this.accepted();
  }

  putBack(): StepResult {
    const held = this.heldOrRefusal();
    if (typeof held !== 'string') return held;
    this.controller.putBack();
    return this.accepted();
  }

  goHome(): StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    this.controller.goHome();
    return this.accepted();
  }

  setBasePose(x: number, y: number, yaw: number): StepResult {
    if (this.mocap < 0) return refused('This scene was built before the arm could move: rebuild it with scan2sim objects');
    const invalid = this.badNumbers(x, y, yaw);
    if (invalid) return invalid;
    const blocked = this.busyReason();
    if (blocked) return blocked;
    if (this.status.holding) return refused(`Holding ${this.name(this.status.holding)}: put it down first`);
    const radius = this.info.footprint_radius ?? DEFAULT_FOOTPRINT_M;
    let z: number;
    let support: string;
    if (this.info.pedestal_m > 0) {
      // On its pedestal, the arm stands on the floor next to furniture.
      const grid = this.scene.navGrid();
      if (grid.clearanceAt(x, y) < radius) return refused('Not on free floor: the pedestal would stand in furniture or a wall');
      z = this.info.pedestal_m;
      support = 'the floor';
    } else {
      const tables = this.scene.tables().filter((t) => discOnRect(t.rect, x, y, radius));
      if (tables.length === 0) return refused('Not on a table: the arm stands on a table top');
      const table = tables.reduce((a, b) => (b.top > a.top ? b : a));
      z = table.top;
      support = table.name;
    }
    for (const object of this.objectNames()) {
      const shape = objectShape(this.physics, object);
      const gap = Math.hypot(shape.center[0] - x, shape.center[1] - y) - shape.radius - radius;
      if (shape.bottom < z + 0.3 && gap < OBJECT_CLEARANCE_M) return refused(`Too close to ${this.name(object)}`);
    }
    this.home = { x, y, z, yaw };
    this.applyBase(this.home);
    return ok(`On ${support} at (${x.toFixed(2)}, ${y.toFixed(2)}) m`);
  }

  dispose(): void {
    this.abandon('Disposed');
    this.controller.dispose();
  }

  private applyBase(pose: BasePose): void {
    const { mujoco, model, data } = this.physics;
    const pos = data.mocap_pos;
    const quat = data.mocap_quat;
    pos[this.mocap * 3] = pose.x;
    pos[this.mocap * 3 + 1] = pose.y;
    pos[this.mocap * 3 + 2] = pose.z;
    quat[this.mocap * 4] = Math.cos(pose.yaw / 2);
    quat[this.mocap * 4 + 1] = 0;
    quat[this.mocap * 4 + 2] = 0;
    quat[this.mocap * 4 + 3] = Math.sin(pose.yaw / 2);
    mujoco.mj_forward(model, data);
  }

  private onStatus(status: RobotStatus): void {
    if (status.phase === 'busy') this.verdict = null;
    if (status.phase === 'idle') {
      this.pickedFrom = null;
      const placing = this.placing;
      this.placing = null;
      const problem = placing && !status.error ? this.placementProblem(placing) : null;
      if (problem) {
        this.verdict = { ...status, text: problem, error: true };
        this.emit(this.verdict);
        return;
      }
    }
    this.emit(status);
  }

  /** Why a released object is not where it was put (it fell, slid or tipped), or null. */
  private placementProblem(placing: { name: string; x: number; y: number; z: number }): string | null {
    const shape = objectShape(this.physics, placing.name);
    const label = this.name(placing.name);
    if (shape.bottom < placing.z - PLACED_HEIGHT_M) return `${label} fell: it lies ${(placing.z - shape.bottom).toFixed(2)} m below where it was put`;
    const off = Math.hypot(shape.center[0] - placing.x, shape.center[1] - placing.y);
    if (off > PLACED_OFFSET_M) return `${label} slid ${(off * 100).toFixed(0)} cm from where it was put`;
    return null;
  }

  private accepted(): StepResult {
    const status = this.status;
    return status.phase === 'busy' ? ok(status.text) : refused(status.text);
  }

  private heldOrRefusal(): string | StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    return this.status.holding ?? refused('Not holding anything');
  }

  private objectNames(): string[] {
    return [...this.labels.keys()];
  }

  private hasObject(name: string): boolean {
    return this.bodyOf(name) >= 0 && this.labels.has(name);
  }

  private bodyOf(name: string): number {
    const { mujoco, model } = this.physics;
    return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
  }
}
