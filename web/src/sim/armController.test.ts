import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { beforeEach, describe, expect, test } from 'vitest';
import type { SceneMeta } from '../scene/bundle';
import { ArmController } from './armController';
import { physicsFrom, type Physics } from './physics';

// Runs the arm on a real scene bundle (`scan2sim objects` output). Bundles are photos of a
// home and stay out of git, so this suite skips when the bundle is missing.
const SCENE_DIR = resolve(process.env.SCAN2SIM_SCENE ?? 'public/scenes/desk-sam3d');
const HAS_SCENE = existsSync(`${SCENE_DIR}/scene.json`);
const MAX_TASK_SECONDS = 20;

function run(physics: Physics, arm: ArmController): void {
  const end = physics.time() + MAX_TASK_SECONDS;
  while (arm.status.phase === 'busy' && physics.time() < end) physics.advance(0.05, () => arm.update());
}

function bodyZ(physics: Physics, name: string): number {
  const { mujoco, model, data } = physics;
  return data.xpos[mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name) * 3 + 2];
}

describe.skipIf(!HAS_SCENE)('arm on a scanned desk', async () => {
  const meta: SceneMeta = HAS_SCENE ? JSON.parse(readFileSync(`${SCENE_DIR}/scene.json`, 'utf8')) : null;
  const mjcf = HAS_SCENE ? readFileSync(`${SCENE_DIR}/${meta.files.mjcf}`, 'utf8') : '';
  const mujoco = await loadMujoco();
  const labels = new Map((meta?.objects ?? []).map((o) => [o.name, o.label]));
  const byLabel = (label: string): string => meta.objects!.find((o) => o.label.includes(label))!.name;
  let physics: Physics;
  let arm: ArmController;

  beforeEach(() => {
    physics = physicsFrom(mujoco, mjcf);
    arm = new ArmController(physics, meta.arm!, labels, () => {});
    physics.advance(0.5); // let the objects settle
  });

  test('picks up the mouse and puts it back', () => {
    const mouse = byLabel('mouse');
    const restZ = bodyZ(physics, mouse);
    arm.pick(mouse);
    run(physics, arm);
    expect(arm.status).toMatchObject({ phase: 'holding', holding: mouse });
    expect(bodyZ(physics, mouse) - restZ).toBeGreaterThan(0.1);

    arm.putBack();
    run(physics, arm);
    for (let i = 0; i < 20; i += 1) physics.advance(0.05);
    expect(arm.status).toMatchObject({ phase: 'idle', error: false });
    expect(Math.abs(bodyZ(physics, mouse) - restZ)).toBeLessThan(0.01);
  });

  test('stacks the earbud case on the ring', () => {
    const earbuds = byLabel('earbud');
    const ring = byLabel('ring');
    arm.pick(earbuds);
    run(physics, arm);
    expect(arm.status).toMatchObject({ phase: 'holding', holding: earbuds });
    arm.placeOn(ring);
    run(physics, arm);
    for (let i = 0; i < 20; i += 1) physics.advance(0.05);
    expect(arm.status).toMatchObject({ phase: 'idle', error: false });
    expect(bodyZ(physics, earbuds)).toBeGreaterThan(bodyZ(physics, ring) + 0.015);
  });

  test('explains what it cannot do', () => {
    arm.pick(byLabel('laptop'));
    expect(arm.status).toMatchObject({ phase: 'idle', error: true });
    expect(arm.status.text).toMatch(/wide|reach/);
    arm.pick(byLabel('cylinder'));
    expect(arm.status.text).toMatch(/wide|reach/);
  });
});
