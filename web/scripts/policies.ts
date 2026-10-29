// Ayna's saved runs as an evaluation set for robot policies. A run with an approved after photo is an
// episode: the twin, the start state and metric goals read off the imagined photo. This replays every
// episode with the same robots under different perception and scores each with the app's verifier,
// so a change to the robots is measured on a real home instead of on hand-written tasks. No model
// calls: the goals are saved with the run.
//
//   cd web && npx tsx scripts/policies.ts --scan desk-sam3d [--since 2026-10-29T03:30] [--policy exact --policy camera]
//     [--out src/landing/facts/policies.json]   # the summary the landing page shows
//
// Policies (where the robots think an object is when they reach for it):
//   exact      the simulator's pose, as in the app
//   camera     only what the photo shows: the centre of the object's SAM 3.1 mask cast onto the table
//   noise-1cm  the simulator's pose plus 1 cm of random error (seeded per episode and object)
//   noise-2cm  the same with 2 cm
//
// Runs are read from the server in AYNA_URL as AYNA_EMAIL (scripts/session.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { scans } from '../src/ayna/client';
import { checkPlan } from '../src/ayna/dispatch';
import { fleetOf, runHeadless } from '../src/ayna/fleet';
import { parseGlb, type TriangleMesh } from '../src/ayna/glb';
import { placeOnPlane, type BeforeMask, type ObjectGoal, type SceneObject } from '../src/ayna/goals';
import { refusedInEdit } from '../src/ayna/pipeline';
import type { RunRecord } from '../src/ayna/record';
import type { Rle } from '../src/ayna/rle';
import { execute, footprintsOf, type SceneContext } from '../src/ayna/run';
import { bodyPose, measure, type BodyPose, type Receipt } from '../src/ayna/verify';
import type { SceneMeta } from '../src/scene/bundle';
import { physicsFrom, type Physics } from '../src/sim/physics';
import { createRobots } from '../src/sim/robots';
import { login } from './session';

const ROOT = path.resolve(import.meta.dirname, '..');
const SETTLE_S = 1.5;
const POLICIES = ['exact', 'camera', 'noise-1cm', 'noise-2cm'] as const;
type Policy = (typeof POLICIES)[number];

function args(name: string): string[] {
  return process.argv.flatMap((arg, i) => (arg === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));
}


/** A small seeded generator (mulberry32), so a noisy policy sees the same error on every rerun. */
function seeded(text: string): () => number {
  let state = [...text].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 2166136261);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number, sigma: number): [number, number] {
  const r = sigma * Math.sqrt(-2 * Math.log(1 - random()));
  const a = 2 * Math.PI * random();
  return [r * Math.cos(a), r * Math.sin(a)];
}

/** Each object's perception error under a policy (world xy, metres). */
function perceptionOf(policy: Policy, episode: string, ctx: SceneContext): Map<string, [number, number]> {
  const errors = new Map<string, [number, number]>();
  for (const object of ctx.objects) {
    if (policy === 'camera') {
      const before = ctx.before.find((b) => b.object === object.name);
      const seen = before ? placeOnPlane(ctx.camera, before.rle, object.start[2]).center : null;
      errors.set(object.name, seen ? [seen[0] - object.start[0], seen[1] - object.start[1]] : [0, 0]);
    } else if (policy !== 'exact') {
      errors.set(object.name, gaussian(seeded(`${episode}/${object.name}`), policy === 'noise-1cm' ? 0.01 : 0.02));
    }
  }
  return errors;
}

interface Scene {
  meta: SceneMeta;
  ctx: SceneContext;
  mjcf: string;
  meshes: Map<string, TriangleMesh>;
}

function loadScene(scanId: string): Scene {
  const dir = path.join(ROOT, '..', 'data', 'scenes', scanId);
  const meta = JSON.parse(readFileSync(path.join(dir, 'scene.json'), 'utf8')) as SceneMeta;
  if (!meta.camera || !meta.objects) throw new Error(`${dir} has no hero camera or objects`);
  const before = JSON.parse(readFileSync(path.join(dir, 'masks.json'), 'utf8')).masks as BeforeMask[];
  const objects: SceneObject[] = meta.objects.map((o) => ({ name: o.name, label: o.label, concept: o.concept, size_m: o.size_m, start: o.start }));
  const meshes = new Map<string, TriangleMesh>(
    meta.objects.map((o) => {
      const bytes = readFileSync(path.join(dir, o.mesh));
      return [o.name, parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))];
    }),
  );
  return { meta, ctx: { camera: meta.camera, photo: '', objects, before }, mjcf: readFileSync(path.join(dir, meta.files.mjcf), 'utf8'), meshes };
}

/** One episode under one policy: the same deterministic plan, then the app's verifier. */
async function replay(mujoco: Awaited<ReturnType<typeof loadMujoco>>, scene: Scene, run: RunRecord, policy: Policy): Promise<{ receipt: Receipt; slipped: number }> {
  const errors = perceptionOf(policy, run.id, scene.ctx);
  const loaded = physicsFrom(mujoco, scene.mjcf);
  const physics: Physics = errors.size ? { ...loaded, perceive: (name) => errors.get(name) ?? [0, 0] } : loaded;
  physics.advance(0.5); // objects settle as in the app
  const robots = createRobots(physics, scene.meta);
  const fleet = fleetOf(physics, robots.robots, robots.scene);
  const goals: ObjectGoal[] = run.goals.map((g) => ({ ...g, source: 'concept', areaRatio: 1 }));
  // Spark's plan is replaced by the checker's own assignment (arm first, blockers first), so every
  // policy gets the same steps.
  const plan = checkPlan({ steps: [], refusals: [], order_reason: '' }, goals, fleet, footprintsOf(scene.ctx));
  const start = new Map<string, BodyPose>(scene.ctx.objects.map((o) => [o.name, bodyPose(physics, o.name)]));
  const executed = await runHeadless(physics, fleet, execute(plan.steps, fleet, () => {}));
  const end = physics.time() + SETTLE_S;
  while (physics.time() < end) physics.advance(0.05, () => fleet.forEach((r) => r.update()));
  const notes = new Map<string, string>();
  for (const r of plan.refusals) notes.set(r.object, `refused: ${r.reason}`);
  for (const e of executed) if (!e.result.ok) notes.set(e.step.object, `failed: ${e.result.reason}`);
  const receipt = measure({
    camera: scene.ctx.camera,
    goals,
    start,
    final: new Map<string, BodyPose>(scene.ctx.objects.map((o) => [o.name, bodyPose(physics, o.name)])),
    meshes: scene.meshes,
    beforeMasks: new Map<string, Rle>(scene.ctx.before.map((b) => [b.object, b.rle])),
    notes,
    refusedBefore: run.instruction ? refusedInEdit(run.instruction, scene.ctx.objects) : undefined,
  });
  robots.dispose(); // each robot's IK holds a scratch MjData in the WASM heap
  physics.dispose();
  return { receipt, slipped: executed.filter((e) => !e.result.ok && /slipped|missed/i.test(e.result.reason)).length };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
};

async function main(): Promise<void> {
  const scanId = args('scan')[0] ?? 'desk-sam3d';
  const since = args('since')[0] ?? '';
  const policies = (args('policy').length ? args('policy') : [...POLICIES]) as Policy[];
  const unknown = policies.filter((p) => !POLICIES.includes(p));
  if (unknown.length) throw new Error(`unknown policy ${unknown.join(', ')}; pick from ${POLICIES.join(', ')}`);
  const scene = loadScene(scanId);
  const { session, owner } = await login();
  const cards = (await scans.runs(session, owner, scanId)).runs.filter((r) => r.score !== null && r.created >= since);
  const runs = (await Promise.all(cards.map(async (c) => (await scans.run(session, owner, scanId, c.id)).run))).filter((r) => r.goals?.some((g) => g.moves));
  console.log(`${scanId}: ${runs.length} episodes with moves${since ? ` since ${since}` : ''}`);
  const mujoco = await loadMujoco();

  const table: { policy: Policy; episodes: number; done: number; asked: number; kept: number; stays: number; meanScore: number; medianMoveErrorCm: number; slipped: number }[] = [];
  for (const policy of policies) {
    const receipts: Receipt[] = [];
    let slipped = 0;
    for (const run of runs) {
      const out = await replay(mujoco, scene, run, policy);
      receipts.push(out.receipt);
      slipped += out.slipped;
      console.log(`  ${policy.padEnd(9)} ${run.id} ${String(out.receipt.score).padStart(3)}  ${out.receipt.moved.done}/${out.receipt.moved.asked} moves  ${run.request.slice(0, 60)}`);
    }
    const moveErrors = receipts.flatMap((r) => r.results.filter((x) => x.wanted === 'move').map((x) => x.errorM * 100));
    table.push({
      policy,
      episodes: receipts.length,
      done: receipts.reduce((s, r) => s + r.moved.done, 0),
      asked: receipts.reduce((s, r) => s + r.moved.asked, 0),
      kept: receipts.reduce((s, r) => s + r.stayed.kept, 0),
      stays: receipts.reduce((s, r) => s + r.stayed.total, 0),
      meanScore: Math.round(receipts.reduce((s, r) => s + r.score, 0) / Math.max(receipts.length, 1)),
      medianMoveErrorCm: Math.round(median(moveErrors) * 10) / 10,
      slipped,
    });
  }
  console.log('\n| Policy | Episodes | Requested moves done | Objects left in place | Mean score | Median error of moved objects, cm | Slipped grasps |');
  console.log('|---|---|---|---|---|---|---|');
  for (const t of table) console.log(`| ${t.policy} | ${t.episodes} | ${t.done}/${t.asked} | ${t.kept}/${t.stays} | ${t.meanScore} | ${t.medianMoveErrorCm.toFixed(1)} | ${t.slipped} |`);
  const summary = { scan: scanId, since, generated: new Date().toISOString(), episodes: runs.length, table };
  console.log(`\n${JSON.stringify(summary)}`);
  const out = args('out')[0];
  if (out) writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
