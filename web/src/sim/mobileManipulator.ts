import type { MobileRobotInfo } from '../scene/bundle';
import { ArmIk, topDown, type IkResult, type Vec3 } from './ik';
import { DriveCurve, MotionQueue, angleTo, roundCorners, type Move } from './motion';
import { canPark, distanceField, insidePolygon, parkingSpots, pathTo, rectDistance, shortcut, type DistanceField, type Parking, type ParkingQuery, type Vec2 } from './navigation';
import { objectShape, type ObjectShape } from './objectShape';
import type { Physics } from './physics';
import { RobotBase, ok, refused, type BasePose, type ReachCheck, type RobotPhase, type RobotStatus, type StepResult } from './robot';
import type { SceneGeometry } from './sceneGeometry';

// The mobile manipulator: plans where to park next to the surface (navigation.ts), drives there
// along an A* path, raises the lift so the arm works at the surface height, and picks or places
// top-down like the stationary arm. Targets: [x, y, yaw, lift, 7 arm joints, gripper].

const APPROACH_M = 0.12; // pre-grasp height above the grasp point
const LIFT_M = 0.15;
const TABLE_GAP_M = 0.006; // fingertips stay this far above the surface the object rests on
const TOP_MARGIN_M = 0.012; // grasp at least this far below the object's top
const PALM_CLEARANCE_M = 0.012; // a tall object's top stays this far below the palm
const PALM_ABOVE_GRIP_M = 0.05; // default for bundles that do not say
const DROP_GAP_M = 0.012; // release this far above the target surface
const WIDTH_MARGIN_M = 0.012;
const LIFTED_M = 0.04; // the object has to rise this much for a grasp to count
const HELD_NEAR_M = 0.12; // a held object stays this close to the grip point
const JOINT_SPEED = 0.9; // rad/s for the joint that moves the most
const MIN_MOVE_S = 0.7;
const CLOSE_S = 0.7;
const SETTLE_S = 0.35;
const RELEASE_S = 0.6;
const LIFT_SPEED = 0.15; // m/s
const STOWED_RAD = 0.05;

// The arm reaches furthest with the grasp point ~8 cm above its base (pipeline: measured band).
const ARM_BELOW_GRASP_M = 0.08;
const GRASP_ABOVE_BASE_M: [number, number] = [-0.05, 0.25];
// Parking keeps targets inside the measured band (0.28-0.76 m; facing the target IK reaches ~0.79 m).
const REACH_INNER_MARGIN_M = 0.03;
const REACH_OUTER_MARGIN_M = 0.03;
const PREFERRED_REACH_M = 0.5;
const PARKING_TRIES = 8;
const ROUND_RATIO = 1.15; // an object this close to round can be grasped from any side
const FOOTPRINT_SHARE = 0.8; // this much of a held object's footprint must rest on the surface
const PLACED_HEIGHT_M = 0.03; // after a release the object rests this close to the planned surface
const PLACED_OFFSET_M = 0.06; // ... and this close to the planned point

const T = { x: 0, y: 1, yaw: 2, lift: 3, arm: 4, grip: 11 } as const;

interface Held {
  name: string;
  gripToBottom: number;
  origin: Vec3; // grip point xy and the surface it was picked from
  yaw: number; // finger direction (world) it was picked with
}

interface Plan {
  spot: Parking;
  yaw: number; // base heading, unwrapped next to the current one
  lift: number;
  qs: number[][];
  gripYaw: number;
  path: [number, number][];
}

export class MobileManipulator extends RobotBase {
  readonly kind = 'mobile' as const;
  private readonly ik: ArmIk;
  private readonly motion: MotionQueue;
  private readonly qposAdr: { x: number; y: number; yaw: number; lift: number };
  private readonly dofAdr: number[];
  private readonly gripSite: number;
  private readonly radius: number; // footprint + planner margin
  private held: Held | null = null;
  private current: RobotStatus = { phase: 'idle', text: 'Ready', holding: null, error: false };
  private home: BasePose;

  constructor(
    private readonly physics: Physics,
    override readonly info: MobileRobotInfo,
    private readonly scene: SceneGeometry,
    labels: ReadonlyMap<string, string>,
  ) {
    super(info, labels);
    const { mujoco, model } = physics;
    const id = (type: number, name: string): number => {
      const index = mujoco.mj_name2id(model, type, name);
      if (index < 0) throw new Error(`scene.xml is missing ${name}`);
      return index;
    };
    const JOINT = mujoco.mjtObj.mjOBJ_JOINT.value;
    const ACTUATOR = mujoco.mjtObj.mjOBJ_ACTUATOR.value;
    const joints = [...info.drive.joints, info.lift.joint].map((n) => id(JOINT, n));
    const [x, y, yaw, lift] = joints.map((j) => model.jnt_qposadr[j]);
    this.qposAdr = { x, y, yaw, lift };
    this.dofAdr = joints.map((j) => model.jnt_dofadr[j]);
    const actuators = [...info.drive.actuators, info.lift.actuator, ...info.arm.joints, info.gripper.actuator].map((n) => id(ACTUATOR, n));
    this.motion = new MotionQueue(physics, actuators);
    this.ik = new ArmIk(physics, info.arm);
    id(mujoco.mjtObj.mjOBJ_BODY.value, info.base); // fail early on a bundle without the chassis
    this.gripSite = id(mujoco.mjtObj.mjOBJ_SITE.value, info.arm.grip_site);
    this.radius = info.footprint_radius + info.nav_margin;
    this.home = this.basePose();
  }

  get status(): RobotStatus {
    return this.current;
  }

  update(): void {
    this.motion.update();
  }

  reset(): void {
    this.abandon('Reset');
    this.held = null;
    this.teleport(this.home);
    this.motion.clear(true);
    this.setStatus('idle', 'Ready');
  }

  basePose(): BasePose {
    const qpos = this.physics.data.qpos;
    return { x: qpos[this.qposAdr.x], y: qpos[this.qposAdr.y], z: 0, yaw: qpos[this.qposAdr.yaw] };
  }

  reachOf(objectName: string): ReachCheck {
    if (!this.hasObject(objectName)) return { ok: false, reason: `no object named ${objectName}`, distance_m: Infinity };
    const shape = objectShape(this.physics, objectName);
    const base = this.basePose();
    const distance = Math.hypot(shape.center[0] - base.x, shape.center[1] - base.y);
    const problems: string[] = [];
    const width = this.widthProblem(shape);
    if (width) problems.push(width);
    const lift = this.liftFor(this.graspHeight(shape));
    if (typeof lift === 'string') problems.push(lift);
    const spot = canPark(this.scene.navGrid(), this.scene.regionsFor(this.radius), [base.x, base.y], this.parkingQuery([shape.center[0], shape.center[1]]));
    if (!spot) problems.push(this.noParkingReason([shape.center[0], shape.center[1]]));
    if (problems.length > 0) return { ok: false, reason: problems.join('; '), distance_m: distance };
    return { ok: true, reason: `can park with it ${spot!.armDistance.toFixed(2)} m from the arm`, distance_m: distance };
  }

  pick(objectName: string): StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    if (this.held) return refused(`Already holding ${this.name(this.held.name)}`);
    if (!this.hasObject(objectName)) return refused(`No object named ${objectName}`);
    const label = this.name(objectName);
    const shape = objectShape(this.physics, objectName);
    const width = this.widthProblem(shape);
    if (width) return this.refuse(`${label}: ${width}`);
    const graspZ = this.graspHeight(shape);
    const target: Vec2 = [shape.center[0], shape.center[1]];
    const round = shape.length / Math.max(shape.width, 1e-6) < ROUND_RATIO;
    const plan = this.plan(target, graspZ, [APPROACH_M, 0, LIFT_M], (heading) =>
      round ? [heading + Math.PI / 2, heading - Math.PI / 2, shape.yaw, shape.yaw + Math.PI] : [shape.yaw, shape.yaw + Math.PI],
    );
    if (typeof plan === 'string') return this.refuse(`${label}: ${plan}`);
    const [above, at, lift] = plan.qs;
    const open = this.info.gripper.open;
    const startZ = this.bodyZ(objectName);
    this.stow(open);
    this.drive(plan, open, () => this.setStatus('busy', `Picking up ${label}`));
    this.armTo(above, open);
    this.armTo(at, open);
    this.hold(at, 0, CLOSE_S);
    this.hold(at, 0, SETTLE_S);
    this.armTo(lift, 0, () => {
      if (this.bodyZ(objectName) - startZ < LIFTED_M) {
        this.armTo(this.stowPose(), open, () => this.fail(`Missed ${label}: it slipped out of the fingers`));
        return;
      }
      this.held = { name: objectName, gripToBottom: graspZ - shape.bottom, origin: [target[0], target[1], shape.bottom], yaw: plan.gripYaw };
      this.setStatus('holding', `Holding ${label}`);
    });
    this.setStatus('busy', `Driving to ${label}`);
    return ok(this.current.text);
  }

  placeAt(x: number, y: number, yawDelta = 0): StepResult {
    const held = this.heldOrRefusal();
    if (!('name' in held)) return held;
    const label = this.name(held.name);
    const shape = objectShape(this.physics, held.name);
    const surface = this.scene.placeSurface(x, y, shape.radius * FOOTPRINT_SHARE, this.bodyOf(held.name));
    if (typeof surface === 'string') return this.refuse(`Can't put ${label} down: ${surface}`);
    const where = `on ${surface.object ? this.name(surface.object) : surface.name} at (${x.toFixed(2)}, ${y.toFixed(2)})`;
    return this.release([x, y], surface.z, held.yaw + yawDelta, where);
  }

  placeOn(objectName: string): StepResult {
    const held = this.heldOrRefusal();
    if (!('name' in held)) return held;
    if (!this.hasObject(objectName) || objectName === held.name) return refused(`Can't put ${this.name(held.name)} on ${this.name(objectName)}`);
    const shape = objectShape(this.physics, objectName);
    return this.release([shape.center[0], shape.center[1]], shape.top, held.yaw, `on ${this.name(objectName)}`);
  }

  putBack(): StepResult {
    const held = this.heldOrRefusal();
    if (!('name' in held)) return held;
    return this.release([held.origin[0], held.origin[1]], held.origin[2], held.yaw, 'back');
  }

  goHome(): StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    const field = distanceField(this.scene.navGrid(), this.xy(), this.radius);
    const goal = this.scene.navGrid().cellAt(this.home.x, this.home.y);
    const cells = field && goal >= 0 ? pathTo(field, goal) : null;
    if (!cells) return this.refuse("Can't find a way back to its spot");
    const path = shortcut(this.scene.navGrid(), [...cells, [this.home.x, this.home.y]], this.radius);
    const grip = this.motion.last()[T.grip];
    this.stow(grip);
    this.driveAlong(path, this.unwrapYaw(this.home.yaw), this.info.lift.home, grip, () =>
      this.setStatus(this.held ? 'holding' : 'idle', this.held ? `Holding ${this.name(this.held.name)}` : 'Back at its spot'),
    );
    this.setStatus('busy', 'Driving back to its spot');
    return ok(this.current.text);
  }

  setBasePose(x: number, y: number, yaw: number): StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    if (this.held) return refused(`Holding ${this.name(this.held.name)}: put it down first`);
    const footprint = this.info.footprint_radius;
    if (this.scene.floor && !insidePolygon(this.scene.floor, x, y)) return refused('Off the scanned floor');
    const inside = this.scene.obstacles().find((r) => rectDistance(r, x, y) < footprint);
    if (inside) return refused(`Inside ${inside.name ?? 'an obstacle'}: the base needs ${(footprint * 200).toFixed(0)} cm of free floor`);
    if (this.scene.navGrid().clearanceAt(x, y) < footprint) return refused('Too close to the edge of the scanned floor');
    this.home = { x, y, z: 0, yaw };
    this.teleport(this.home);
    return ok(`On the floor at (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }

  dispose(): void {
    this.abandon('Disposed');
    this.ik.dispose();
  }

  // --- planning -------------------------------------------------------------------------------

  /** Park, lift and arm poses to reach a point at height z; a reason when there are none. */
  private plan(target: Vec2, z: number, heights: [number, number, number], yaws: (heading: number) => number[]): Plan | string {
    const lift = this.liftFor(z);
    if (typeof lift === 'string') return lift;
    const grid = this.scene.navGrid();
    const field = distanceField(grid, this.xy(), this.radius);
    if (!field) return 'the robot is boxed in';
    const spots = parkingSpots(field, this.parkingQuery(target), PARKING_TRIES);
    if (spots.length === 0) return this.noParkingReason(target);
    try {
      for (const spot of spots) {
        const yaw = this.unwrapYaw(spot.yaw);
        const { x, y, yaw: yawAdr, lift: liftAdr } = this.qposAdr;
        this.ik.plannedState([
          [x, spot.x],
          [y, spot.y],
          [yawAdr, yaw],
          [liftAdr, lift],
        ]);
        const reach = this.planVertical([target[0], target[1], z], heights, yaws(spot.yaw));
        if (reach) return { spot, yaw, lift, qs: reach.qs, gripYaw: reach.yaw, path: this.pathTo(field, spot) };
      }
    } finally {
      this.ik.plannedState([]);
    }
    return `the arm finds no grasp from ${spots.length} parking spots`;
  }

  /** IK for a point and offsets straight above it; the first grasp yaw whose poses all solve. */
  private planVertical(point: Vec3, heights: [number, number, number], yaws: number[]): { qs: number[][]; yaw: number } | null {
    for (const yaw of yaws) {
      const rotation = topDown(yaw);
      const qs: number[][] = [];
      let seed: readonly number[] = this.stowPose();
      for (const dz of heights) {
        const result: IkResult = this.ik.solve([point[0], point[1], point[2] + dz], rotation, seed);
        if (!result.ok) break;
        qs.push(result.q);
        seed = result.q;
      }
      if (qs.length === heights.length) return { qs, yaw };
    }
    return null;
  }

  private pathTo(field: DistanceField, spot: Parking): [number, number][] {
    const cells = pathTo(field, spot.index) ?? [[spot.x, spot.y]];
    return shortcut(this.scene.navGrid(), cells, this.radius);
  }

  private parkingQuery(target: Vec2): ParkingQuery {
    const [min, max] = this.info.reach_m;
    return {
      target,
      reach: [min + REACH_INNER_MARGIN_M, max - REACH_OUTER_MARGIN_M],
      preferred: PREFERRED_REACH_M,
      armOffset: this.info.arm_offset_m,
      radius: this.radius,
      blockers: this.scene.walls(),
    };
  }

  private noParkingReason(target: Vec2): string {
    const grid = this.scene.navGrid();
    let nearest = Infinity;
    const r = Math.ceil(1.5 / grid.cell);
    const ci = Math.floor((target[0] - grid.originX) / grid.cell);
    const cj = Math.floor((target[1] - grid.originY) / grid.cell);
    for (let j = Math.max(0, cj - r); j <= Math.min(grid.ny - 1, cj + r); j += 1) {
      for (let i = Math.max(0, ci - r); i <= Math.min(grid.nx - 1, ci + r); i += 1) {
        const index = j * grid.nx + i;
        if (!grid.free(index, this.radius)) continue;
        const [x, y] = grid.centerOf(index);
        nearest = Math.min(nearest, Math.hypot(x - target[0], y - target[1]) - this.info.arm_offset_m);
      }
    }
    const reach = (this.info.reach_m[1] - REACH_OUTER_MARGIN_M).toFixed(2);
    return Number.isFinite(nearest)
      ? `no free floor close enough: parked, the arm would be ${nearest.toFixed(2)} m away, it reaches ${reach} m`
      : `no free floor close enough (the arm reaches ${reach} m)`;
  }

  /** Lift joint value that puts the arm base ARM_BELOW_GRASP_M under a grasp at height z. */
  private liftFor(z: number): number | string {
    const [low, high] = this.info.lift.arm_base_z;
    const [qMin, qMax] = this.info.lift.range;
    const q = Math.min(Math.max(z - ARM_BELOW_GRASP_M - low, qMin), qMax);
    const above = z - (low + q);
    if (above > GRASP_ABOVE_BASE_M[1]) return `${z.toFixed(2)} m high, the lift reaches ${(high + GRASP_ABOVE_BASE_M[1]).toFixed(2)} m`;
    if (above < GRASP_ABOVE_BASE_M[0]) return `${z.toFixed(2)} m high, too low for the lift (${(low + GRASP_ABOVE_BASE_M[0]).toFixed(2)} m)`;
    return q;
  }

  /** Mid-height, but never so low that a tall object's top runs into the palm. */
  private graspHeight(shape: ObjectShape): number {
    const { tip_below_grip: tipBelow, palm_above_grip: palm = PALM_ABOVE_GRIP_M } = this.info.gripper;
    return Math.max(
      shape.bottom + tipBelow + TABLE_GAP_M,
      Math.min((shape.bottom + shape.top) / 2, shape.top - TOP_MARGIN_M),
      shape.top - palm + PALM_CLEARANCE_M,
    );
  }

  private widthProblem(shape: ObjectShape): string | null {
    const max = this.info.gripper.max_width;
    return shape.width > max - WIDTH_MARGIN_M ? `${(shape.width * 100).toFixed(1)} cm wide, gripper opens to ${(max * 100).toFixed(0)} cm` : null;
  }

  // --- execution ------------------------------------------------------------------------------

  private release(point: Vec2, surfaceZ: number, yaw: number, where: string): StepResult {
    const held = this.held!;
    const label = this.name(held.name);
    const z = surfaceZ + held.gripToBottom + DROP_GAP_M;
    let turned = false;
    let plan = this.plan(point, z, [APPROACH_M, 0, APPROACH_M], () => [yaw]);
    if (typeof plan === 'string') {
      const flipped = this.plan(point, z, [APPROACH_M, 0, APPROACH_M], () => [yaw + Math.PI]);
      if (typeof flipped === 'string') return this.refuse(`Can't put ${label} ${where}: ${plan}`);
      plan = flipped;
      turned = true;
    }
    const [above, at, retreat] = plan.qs;
    const open = this.info.gripper.open;
    const done = `Put ${label} ${where}${turned ? ' (turned 180°: the wrist cannot reach that heading)' : ''}`;
    this.stow(0);
    this.drive(plan, 0, () => this.setStatus('busy', `Putting ${label} ${where}`));
    this.armTo(above, 0, undefined, () => {
      if (!this.stillHeld(held.name)) {
        this.motion.halt();
        this.held = null;
        this.fail(`Dropped ${label} on the way`);
      }
    });
    this.armTo(at, 0);
    this.hold(at, open, RELEASE_S, () => {
      this.held = null;
    });
    this.armTo(retreat, open);
    this.armTo(this.stowPose(), open, () => {
      const problem = this.placementProblem(held.name, point, surfaceZ);
      if (problem) this.fail(problem);
      else this.setStatus('idle', done);
    });
    this.setStatus('busy', `Carrying ${label} ${where}`);
    return ok(this.current.text);
  }

  /** Why a released object is not where it was put (it fell, slid or tipped), or null. */
  private placementProblem(name: string, point: Vec2, surfaceZ: number): string | null {
    const shape = objectShape(this.physics, name);
    const label = this.name(name);
    if (shape.bottom < surfaceZ - PLACED_HEIGHT_M) return `${label} fell: it lies ${(surfaceZ - shape.bottom).toFixed(2)} m below where it was put`;
    if (shape.bottom > surfaceZ + PLACED_HEIGHT_M) return `${label} did not settle: it rests ${(shape.bottom - surfaceZ).toFixed(2)} m above the surface`;
    const off = Math.hypot(shape.center[0] - point[0], shape.center[1] - point[1]);
    if (off > PLACED_OFFSET_M) return `${label} slid ${(off * 100).toFixed(0)} cm from where it was put`;
    return null;
  }

  private stow(grip: number): void {
    const last = this.motion.last();
    const stow = this.stowPose();
    const far = stow.some((v, i) => Math.abs(v - last[T.arm + i]) > STOWED_RAD);
    if (far) this.armTo(stow, grip);
  }

  private drive(plan: Plan, grip: number, onArrive: () => void): void {
    this.driveAlong([...plan.path], plan.yaw, plan.lift, grip, onArrive);
  }

  private driveAlong(waypoints: [number, number][], yaw: number, lift: number, grip: number, onArrive: () => void): void {
    const grid = this.scene.navGrid();
    const tolerance = this.radius - 0.01;
    const points = roundCorners(waypoints, (p) => grid.clearanceAt(p[0], p[1]) >= tolerance);
    const from = this.motion.last();
    const to = from.slice();
    const end = points[points.length - 1];
    to[T.x] = end[0];
    to[T.y] = end[1];
    to[T.yaw] = yaw;
    to[T.lift] = lift;
    to[T.grip] = grip;
    const { max_speed: speed, max_accel: accel, max_turn_rate: turnRate } = this.info.drive;
    const turnTime = (1.875 * Math.abs(yaw - from[T.yaw])) / turnRate;
    const liftTime = (1.875 * Math.abs(lift - from[T.lift])) / LIFT_SPEED;
    const curve = new DriveCurve(points).timed(speed, accel, Math.max(turnTime, liftTime, MIN_MOVE_S));
    const move: Move = { to, duration: curve.duration, curve, onDone: onArrive };
    this.motion.push(move);
  }

  private armTo(q: readonly number[], grip: number, onDone?: () => void, onStart?: () => void): void {
    const from = this.motion.last();
    const travel = Math.max(...q.map((v, i) => Math.abs(v - from[T.arm + i])));
    const to = from.slice();
    q.forEach((v, i) => {
      to[T.arm + i] = v;
    });
    to[T.grip] = grip;
    this.motion.push({ to, duration: Math.max(MIN_MOVE_S, travel / JOINT_SPEED), onDone, onStart });
  }

  private hold(q: readonly number[], grip: number, duration: number, onDone?: () => void): void {
    const to = this.motion.last();
    q.forEach((v, i) => {
      to[T.arm + i] = v;
    });
    to[T.grip] = grip;
    this.motion.push({ to, duration, onDone });
  }

  private teleport(pose: BasePose): void {
    const { mujoco, model, data } = this.physics;
    const qpos = data.qpos;
    const qvel = data.qvel;
    qpos[this.qposAdr.x] = pose.x;
    qpos[this.qposAdr.y] = pose.y;
    qpos[this.qposAdr.yaw] = pose.yaw;
    for (const dof of this.dofAdr.slice(0, 3)) qvel[dof] = 0;
    const ctrl = data.ctrl;
    const [ax, ay, ayaw] = this.motion.actuators;
    ctrl[ax] = pose.x;
    ctrl[ay] = pose.y;
    ctrl[ayaw] = pose.yaw;
    this.motion.clear(true);
    mujoco.mj_forward(model, data);
  }

  // --- state ----------------------------------------------------------------------------------

  private stowPose(): number[] {
    return (this.info.arm.stow ?? this.info.arm.home).slice();
  }

  private xy(): Vec2 {
    const pose = this.basePose();
    return [pose.x, pose.y];
  }

  private unwrapYaw(yaw: number): number {
    const current = this.motion.last()[T.yaw];
    return current + angleTo(current, yaw);
  }

  private stillHeld(name: string): boolean {
    const { data } = this.physics;
    const body = this.bodyOf(name);
    const grip = data.site_xpos.subarray(this.gripSite * 3, this.gripSite * 3 + 3);
    const p = data.xpos.subarray(body * 3, body * 3 + 3);
    return Math.hypot(p[0] - grip[0], p[1] - grip[1], p[2] - grip[2]) < HELD_NEAR_M;
  }

  private heldOrRefusal(): Held | StepResult {
    const blocked = this.busyReason();
    if (blocked) return blocked;
    return this.held ?? refused('Not holding anything');
  }

  private hasObject(name: string): boolean {
    return this.labels.has(name) && this.bodyOf(name) >= 0;
  }

  private bodyOf(name: string): number {
    const { mujoco, model } = this.physics;
    return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
  }

  private bodyZ(name: string): number {
    return this.physics.data.xpos[this.bodyOf(name) * 3 + 2];
  }

  private refuse(text: string): StepResult {
    this.setStatus(this.held ? 'holding' : 'idle', text, true);
    return refused(text);
  }

  private fail(text: string): void {
    this.setStatus(this.held ? 'holding' : 'idle', text, true);
  }

  private setStatus(phase: RobotPhase, text: string, error = false): void {
    this.current = { phase, text, holding: this.held?.name ?? null, error };
    this.emit(this.current);
  }
}
