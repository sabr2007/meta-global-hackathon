import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { beforeEach, describe, expect, test } from 'vitest';
import type { MobileRobotInfo, SceneMeta } from '../scene/bundle';
import { angleTo } from './motion';
import { rectDistance } from './navigation';
import { objectShape } from './objectShape';
import { physicsFrom, type Physics } from './physics';
import { createRobots, type Robot, type RobotFleet, type StepResult } from './robots';

// Runs both robots on a real scene bundle (`scan2sim objects` output with robots[]). Bundles are
// photos of a home and stay out of git, so this suite skips when the bundle is missing.
const SCENE_DIR = resolve(process.env.SCAN2SIM_SCENE ?? '../data/scenes/desk-sam3d');
const META: SceneMeta | null = existsSync(`${SCENE_DIR}/scene.json`) ? JSON.parse(readFileSync(`${SCENE_DIR}/scene.json`, 'utf8')) : null;
const HAS_ROBOTS = (META?.robots ?? []).some((r) => r.kind === 'mobile');
const STEP_S = 0.05;
const DESK_TOP_M = 0.784;

interface Timed extends StepResult {
  seconds: number;
}

/** Step the simulation (robots updated before every step) until the command settles. */
async function settle(physics: Physics, fleet: RobotFleet, pending: Promise<StepResult>, maxSeconds = 90, watch?: () => void): Promise<Timed> {
  let result: StepResult | null = null;
  void pending.then((r) => {
    result = r;
  });
  const start = physics.time();
  await Promise.resolve();
  while (!result && physics.time() - start < maxSeconds) {
    physics.advance(STEP_S, fleet.update);
    watch?.();
    await Promise.resolve();
  }
  return { ...(result ?? { ok: false, reason: `still busy after ${maxSeconds} s` }), seconds: physics.time() - start };
}

function rest(physics: Physics, fleet: RobotFleet, seconds = 1): void {
  for (let t = 0; t < seconds; t += STEP_S) physics.advance(STEP_S, fleet.update);
}

describe.skipIf(!HAS_ROBOTS)('robots on a scanned desk', async () => {
  const meta = META!;
  const mjcf = HAS_ROBOTS ? readFileSync(`${SCENE_DIR}/${meta.files.mjcf}`, 'utf8') : '';
  const mujoco = await loadMujoco();
  const byLabel = (label: string): string => meta.objects!.find((o) => o.label.includes(label))!.name;
  let physics: Physics;
  let fleet: RobotFleet;
  let arm: Robot;
  let rover: Robot;

  beforeEach(() => {
    physics = physicsFrom(mujoco, mjcf);
    fleet = createRobots(physics, meta);
    arm = fleet.get('arm')!;
    rover = fleet.get('mobile')!;
    rest(physics, fleet, 0.5); // let the objects settle
  });

  test('the mobile manipulator takes the yellow cylinder', async () => {
    const cylinder = byLabel('cylinder');
    // At its measured 9 cm (SAM 3D alone made it 10.8 cm) the cylinder fits the arm's gripper too.
    expect(arm.reachOf(cylinder)).toMatchObject({ ok: true });
    expect(rover.reachOf(cylinder)).toMatchObject({ ok: true });

    const start = objectShape(physics, cylinder);
    const startBase = rover.basePose();
    const picked = await settle(physics, fleet, rover.run({ action: 'pick', object: cylinder }));
    expect(picked).toMatchObject({ ok: true, reason: 'Holding yellow cylinder' });
    expect(objectShape(physics, cylinder).bottom - start.bottom).toBeGreaterThan(0.1);

    // Carry it back to the start spot and return: it stays in the gripper while the base drives.
    const home = await settle(physics, fleet, rover.run({ action: 'home' }));
    expect(home.ok).toBe(true);
    expect(rover.status).toMatchObject({ phase: 'holding', holding: cylinder });
    expect(Math.hypot(rover.basePose().x - startBase.x, rover.basePose().y - startBase.y)).toBeLessThan(0.01);

    // Put it down 5 cm from where it was, turned a quarter turn.
    const target: [number, number] = [start.center[0] - 0.045, start.center[1] + 0.025];
    const placed = await settle(physics, fleet, rover.run({ action: 'placeAt', x: target[0], y: target[1], yawDelta: Math.PI / 2 }));
    rest(physics, fleet);
    const end = objectShape(physics, cylinder);
    console.info(`mobile: pick ${picked.seconds.toFixed(1)} s, home ${home.seconds.toFixed(1)} s, place ${placed.seconds.toFixed(1)} s`);
    expect(placed).toMatchObject({ ok: true });
    expect(rover.status).toMatchObject({ phase: 'idle', error: false, holding: null });
    expect(Math.abs(end.bottom - DESK_TOP_M)).toBeLessThan(0.015);
    expect(Math.hypot(end.center[0] - target[0], end.center[1] - target[1])).toBeLessThan(0.04);
    expect(picked.seconds + home.seconds + placed.seconds).toBeLessThan(60);
  });

  test('drives across the room around the furniture, never touching it', async () => {
    const cylinder = byLabel('cylinder');
    expect(rover.setBasePose(1.5, -1.0, Math.PI)).toMatchObject({ ok: true });
    const obstacles = fleet.scene.obstacles();
    const footprint = (rover.info as MobileRobotInfo).footprint_radius;
    let closest = Infinity;
    let travelled = 0;
    let last = rover.basePose();
    const picked = await settle(physics, fleet, rover.run({ action: 'pick', object: cylinder }), 90, () => {
      const p = rover.basePose();
      for (const r of obstacles) closest = Math.min(closest, rectDistance(r, p.x, p.y));
      travelled += Math.hypot(p.x - last.x, p.y - last.y);
      last = p;
    });
    console.info(`mobile: drove ${travelled.toFixed(2)} m and picked in ${picked.seconds.toFixed(1)} s, ${(closest - footprint).toFixed(3)} m to spare`);
    expect(picked).toMatchObject({ ok: true });
    expect(travelled).toBeGreaterThan(3);
    expect(closest).toBeGreaterThan(footprint); // the base disc never overlapped a wall or furniture box
  });

  test('a pick-and-place step in one run() call', async () => {
    const cylinder = byLabel('cylinder');
    const start = objectShape(physics, cylinder);
    const result = await settle(physics, fleet, rover.run({ object: cylinder, x: start.center[0], y: start.center[1] + 0.03 }));
    console.info(`mobile: pick and place ${result.seconds.toFixed(1)} s`);
    expect(result).toMatchObject({ ok: true });
    rest(physics, fleet);
    expect(objectShape(physics, cylinder).center[1] - start.center[1]).toBeGreaterThan(0.01);
  });

  test('the mobile manipulator explains what it cannot do', async () => {
    const laptop = byLabel('laptop');
    const check = rover.reachOf(laptop);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/cm wide, needs [0-9.]+ cm with clearance, gripper opens 16 cm/);
    // The keyboard fits the 16 cm gripper, but held by its 2 cm edge it swung out on every drive.
    expect(rover.reachOf(byLabel('keyboard')).reason).toMatch(/27 cm long and 1\.9 cm thin: held by that edge it slips out while the base drives/);
    expect(rover.pick(laptop)).toMatchObject({ ok: false });
    expect(rover.status.error).toBe(true);
    expect(rover.placeAt(-1, 2.5)).toEqual({ ok: false, reason: 'Not holding anything' });
    const sofa = fleet.scene.element('sofa_0')!.rect;
    expect(rover.setBasePose(sofa.x, sofa.y, 0).reason).toMatch(/Inside sofa_0/);

    const cylinder = byLabel('cylinder');
    await settle(physics, fleet, rover.run({ action: 'pick', object: cylinder }));
    const chair = fleet.scene.element('chair_1')!.rect;
    expect(rover.placeAt(chair.x, chair.y).reason).toMatch(/RoomPlan box around a chair/);
    const desk = fleet.scene.element('table_0')!.rect;
    const edge: [number, number] = [desk.x + desk.ux * desk.hu, desk.y + desk.uy * desk.hu];
    expect(rover.placeAt(...edge).reason).toMatch(/edge of the table/);
    expect(rover.status).toMatchObject({ phase: 'holding', holding: cylinder });
  });

  test('the arm moves along the table, and its IK follows the base', async () => {
    const mouse = byLabel('mouse');
    const cylinder = byLabel('cylinder');
    const before = arm.reachOf(cylinder);
    expect(arm.setBasePose(-1.2, 2.2, 0).reason).toMatch(/Not on a table/);
    const laptop = objectShape(physics, byLabel('laptop'));
    expect(arm.setBasePose(laptop.center[0], laptop.center[1], 0).reason).toMatch(/Too close to silver laptop/);
    // 6 cm across the desk towards its front edge, turned 17 degrees (towards the objects the
    // keyboard is in the way).
    const base = arm.basePose();
    const desk = fleet.scene.element('table_0')!.rect;
    expect(arm.setBasePose(base.x + 0.1 * desk.ux, base.y + 0.1 * desk.uy, base.yaw).reason).toMatch(/Too close to white keyboard/);
    const spot = { x: base.x + 0.06 * desk.uy, y: base.y - 0.06 * desk.ux, yaw: base.yaw + 0.3 };
    expect(arm.setBasePose(spot.x, spot.y, spot.yaw)).toMatchObject({ ok: true });
    expect(arm.basePose()).toMatchObject({ z: expect.closeTo(fleet.scene.element('table_0')!.top, 6), yaw: expect.closeTo(spot.yaw, 6) });
    expect(Math.abs(arm.reachOf(cylinder).distance_m - before.distance_m)).toBeGreaterThan(0.02);

    // Turn the mouse 30 degrees where it lies, from the new spot.
    const start = objectShape(physics, mouse);
    const result = await settle(physics, fleet, arm.run({ object: mouse, x: start.center[0], y: start.center[1], yawDelta: Math.PI / 6 }));
    rest(physics, fleet);
    expect(result).toMatchObject({ ok: true });
    const end = objectShape(physics, mouse);
    const turned = Math.abs(angleTo(start.yaw, end.yaw));
    expect(Math.min(turned, Math.PI - turned)).toBeGreaterThan(0.35); // ~30 degrees (a footprint axis has no sign)
    expect(Math.hypot(end.center[0] - start.center[0], end.center[1] - start.center[1])).toBeLessThan(0.03);

    // reset() keeps the arm where it was dragged.
    physics.reset();
    fleet.reset();
    expect(arm.basePose().x).toBeCloseTo(spot.x, 6);
  });
  test('Ayna treats a goal past the table edge as one no robot can put down, and redraws it', async () => {
    const { fleetOf } = await import('../ayna/fleet');
    const robots = fleetOf(physics, fleet.robots, fleet.scene);
    const cylinder = meta.objects!.find((o) => o.label.includes('cylinder'))!;
    // A real after photo's goal: the front right corner, its centre 6 cm past the edge of the desk.
    for (const robot of robots) expect(robot.reachPoint(-1.217, 2.21, cylinder.name).reason).toMatch(/6 cm past the edge of the table/);
    // Where it stands now is on the desk and within the arm's reach.
    expect(robots.find((r) => r.kind === 'arm')!.reachPoint(cylinder.start[0], cylinder.start[1], cylinder.name)).toMatchObject({ ok: true });
  });
});
