// Run Ayna end to end without a browser: live Meta models through the local server, robots in
// MuJoCo (WASM in Node), the same verifier as the app. Each run is saved to the scan's history.
//
//   npm run dev            # in another terminal: the API on :5190
//   npx tsx scripts/eval.ts --scan desk-sam3d --request "Tidy up my desk" [--request ...] [--no-save]
//   npx tsx scripts/eval.ts --scan desk-sam3d --voice request.wav      # spoken request via Voice Transcribe

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import loadMujoco from '@mujoco/mujoco';
import { models, scans, verdict } from '../src/ayna/client';
import { fleetOf, runHeadless } from '../src/ayna/fleet';
import { parseGlb, type TriangleMesh } from '../src/ayna/glb';
import type { BeforeMask, SceneObject } from '../src/ayna/goals';
import { refusedInEdit, runAyna } from '../src/ayna/pipeline';
import type { Usage } from '../src/ayna/run';
import type { SceneMeta } from '../src/scene/bundle';
import { physicsFrom } from '../src/sim/physics';
import { createRobots } from '../src/sim/robots';
import { BASE, login } from './session';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOG = process.env.AYNA_EVAL_LOG ?? path.join(ROOT, '..', 'data', 'eval-runs.jsonl'); // one JSON line per run

function args(name: string): string[] {
  return process.argv.flatMap((arg, i) => (arg === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));
}


async function main(): Promise<void> {
  const scanId = args('scan')[0] ?? 'desk-sam3d';
  const requests = args('request');
  const voices = args('voice');
  if (!requests.length && !voices.length) throw new Error('pass at least one --request or --voice');
  const dir = path.join(ROOT, '..', 'data', 'scenes', scanId);
  if (!existsSync(dir)) throw new Error(`no bundle at ${dir}`);
  const meta = JSON.parse(readFileSync(path.join(dir, 'scene.json'), 'utf8')) as SceneMeta;
  if (!meta.camera || !meta.objects) throw new Error('bundle has no hero camera or objects; rebuild it with scan2sim objects');
  const masks = JSON.parse(readFileSync(path.join(dir, 'masks.json'), 'utf8')).masks as BeforeMask[];
  const mjcf = readFileSync(path.join(dir, meta.files.mjcf), 'utf8');
  const photo = `data:image/jpeg;base64,${readFileSync(path.join(dir, 'hero.jpg')).toString('base64')}`;
  const meshes = new Map<string, TriangleMesh>(
    meta.objects!.map((o) => {
      const bytes = readFileSync(path.join(dir, o.mesh));
      return [o.name, parseGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))];
    }),
  );
  const mujoco = await loadMujoco();
  const { session, owner } = await login();
  const api = models(session);

  const spoken = new Map<string, Usage[]>(); // request -> the Voice Transcribe call that heard it
  for (const file of voices) {
    const heard = await api.listen(new Uint8Array(readFileSync(file)));
    console.log(`Voice Transcribe heard: "${heard.text}" (${heard.usage[0]?.ms} ms)`);
    spoken.set(heard.text, heard.usage);
    requests.push(heard.text);
  }
  for (const request of requests) {
    const physics = physicsFrom(mujoco, mjcf);
    physics.advance(0.5); // objects settle as in the app
    const objects: SceneObject[] = meta.objects!.map((o) => ({ name: o.name, label: o.label, concept: o.concept, size_m: o.size_m, start: o.start }));
    const robots = createRobots(physics, meta);
    const fleet = fleetOf(physics, robots.robots, robots.scene);
    const started = Date.now();
    const out = await runAyna(
      { ctx: { camera: meta.camera!, photo, objects, before: masks }, physics, fleet, meshes },
      request,
      api,
      {
        approve: async () => true,
        drive: (work) => runHeadless(physics, fleet, work),
        settle: async (seconds) => {
          const end = physics.time() + seconds;
          while (physics.time() < end) physics.advance(0.05, () => fleet.forEach((r) => r.update()));
        },
        verdict: (input) => verdict(session, input),
        trace: (e) => console.log(`  [${e.step}] ${e.state} ${e.text.slice(0, 160)}`),
      },
      spoken.has(request) ? 'voice' : 'eval',
    );
    const heard = spoken.get(request);
    if (heard) {
      // The run starts where the app's does: with the spoken request, so its replay shows Voice Transcribe too.
      out.record.transcript = request;
      out.record.trace.unshift({ step: 'listen', state: 'done', text: `“${request}”`, usage: heard, at: 0 });
      out.record.costUsd += heard.reduce((sum, u) => sum + u.costUsd, 0);
    }
    const { record } = out;
    if (!args('no-save').length && !process.argv.includes('--no-save')) await scans.saveRun(session, owner, scanId, record, out.files);
    const rejected = record.candidates.filter((c) => !c.passed).length;
    const line = {
      server: BASE,
      at: new Date().toISOString(),
      scan: scanId,
      request,
      source: spoken.has(request) ? 'voice' : 'text',
      run: record.id,
      status: record.status,
      score: record.score,
      matched: record.receipt?.matched ?? null,
      total: record.receipt?.total ?? null,
      medianErrorCm: record.receipt?.medianErrorCm ?? null,
      moved: record.receipt?.moved ?? null,
      candidates: record.candidates.length,
      rejected,
      refusals: record.refusals.map((r) => `${r.label}: ${r.reason}`),
      // moves the request implied that Spark kept out of the edit (they count as asked and not done)
      refusedBeforeEdit: record.instruction ? [...refusedInEdit(record.instruction, objects)].map(([name, reason]) => `${name}: ${reason}`) : [],
      failedSteps: record.executed.filter((e) => !e.ok).map((e) => `${e.object}: ${e.reason}`),
      costUsd: Number(record.costUsd.toFixed(4)),
      seconds: Math.round((Date.now() - started) / 1000),
      error: record.error ?? null,
    };
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify(line)}\n`);
    console.log(JSON.stringify(line));
    for (const r of record.receipt?.results ?? []) {
      console.log(`    ${r.label.padEnd(20)} ${r.wanted.padEnd(5)} err ${(r.errorM * 100).toFixed(1).padStart(5)} cm  iou ${r.iou?.toFixed(2) ?? '-'} (base ${r.baselineIou?.toFixed(2) ?? '-'}) ${r.ok ? 'OK' : 'MISS'} ${r.note}`);
    }
    robots.dispose(); // free the WASM heap before the next request's scene
    physics.dispose();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
