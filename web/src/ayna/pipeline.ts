// A whole Ayna run from a sentence to a receipt, with hooks where the browser waits for a person
// (approve the after photo) or shows things (render), and where Node drives the physics itself.

import type { TriangleMesh } from './glb';
import type { FleetRobot } from './fleet';
import { newRunId, type RunRecord } from './record';
import type { Rle } from './rle';
import { dispatch, execute, imagineAfter, type Dispatch, type Imagined, type Models, type RunOptions, type SceneContext, type Trace, type TraceEvent, DEFAULT_OPTIONS } from './run';
import { bodyPose, measure, type BodyPose, type Receipt } from './verify';
import type { Physics } from '../sim/physics';

export interface SceneRuntime {
  ctx: SceneContext;
  physics: Physics;
  fleet: FleetRobot[];
  meshes: Map<string, TriangleMesh>;
}

export interface RunHooks {
  approve(imagined: Imagined): Promise<boolean>;
  drive<T>(work: Promise<T>): Promise<T>;
  /** Let the simulation run for a while (objects come to rest). */
  settle(seconds: number): Promise<void>;
  /** The checked plan, before the robots start (the browser shows it and flies into the twin). */
  onPlan?(planned: Dispatch): Promise<void>;
  render?(): Promise<string | null>;
  verdict?(input: { request: string; after: string; render: string; results: string[]; score: number }): Promise<{ verdict: { verdict: string; matches_request: boolean }; usage: TraceEvent['usage'] }>;
  trace?: Trace;
}

export interface RunOutput {
  record: RunRecord;
  files: Record<string, string>; // file name -> data URL (candidate pictures, render)
  imagined: Imagined | null;
  receipt: Receipt | null;
}

const SETTLE_S = 1.0;

const extension = (dataUrl: string): string => dataUrl.slice(5, dataUrl.indexOf(';')).split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';

export function resultLines(receipt: Receipt): string[] {
  return receipt.results.map(
    (r) =>
      `- ${r.label}: ${r.wanted === 'move' ? 'should move' : 'should stay'}, off by ${(r.errorM * 100).toFixed(1)} cm${r.headingErrorDeg !== null ? `, heading off ${r.headingErrorDeg.toFixed(0)}°` : ''}, ${r.ok ? 'matches' : 'does not match'}${r.note ? ` (${r.note})` : ''}`,
  );
}

export async function runAyna(scene: SceneRuntime, request: string, models: Models, hooks: RunHooks, source: RunRecord['source'] = 'text', options: RunOptions = DEFAULT_OPTIONS): Promise<RunOutput> {
  const started = Date.now();
  const record: RunRecord = {
    version: 1,
    id: newRunId(),
    created: new Date().toISOString(),
    request,
    source,
    status: 'failed',
    instruction: null,
    feedback: [],
    candidates: [],
    chosen: null,
    judgement: null,
    goals: [],
    steps: [],
    refusals: [],
    fixes: [],
    orderReason: '',
    executed: [],
    receipt: null,
    verdict: null,
    trace: [],
    costUsd: 0,
    durationMs: 0,
    score: null,
    thumb: null,
  };
  const files: Record<string, string> = {};
  const trace: Trace = (event) => {
    const { image, check, ...saved } = event;
    void image;
    void check;
    record.trace.push({ ...saved, at: Date.now() - started });
    record.costUsd += (event.usage ?? []).reduce((s, u) => s + u.costUsd, 0);
    hooks.trace?.(event);
  };
  const finish = (): RunOutput => {
    record.durationMs = Date.now() - started;
    return { record, files, imagined, receipt: record.receipt };
  };
  let imagined: Imagined | null = null;
  try {
    imagined = await imagineAfter(scene.ctx, request, scene.fleet, models, trace, options);
    record.instruction = imagined.instruction;
    record.feedback = imagined.feedback;
    for (const c of imagined.candidates) {
      const file = `candidate-${c.id}.${extension(c.image)}`;
      files[file] = c.image;
      record.candidates.push({ id: c.id, round: c.round, file, width: c.width, height: c.height, passed: c.check.passed, reasons: c.check.reasons, notes: c.check.notes });
    }
    if (!imagined.chosen) {
      record.status = 'no-after';
      return finish();
    }
    const chosen = imagined.chosen;
    record.chosen = chosen.id;
    record.judgement = imagined.judgement;
    record.thumb = record.candidates.find((c) => c.id === chosen.id)!.file;
    record.goals = chosen.check.goals.map((g) => ({ name: g.name, label: g.label, found: g.found, moves: g.moves, from: g.from, to: g.to, yawDelta: g.yawDelta, distanceM: g.distanceM, mask: g.mask }));
    if (!(await hooks.approve(imagined))) {
      record.status = 'failed';
      record.error = 'Not approved';
      return finish();
    }

    const planned = await dispatch(scene.ctx, request, chosen, scene.fleet, models, trace);
    record.steps = planned.steps;
    record.refusals = planned.refusals;
    record.fixes = planned.fixes;
    record.orderReason = planned.orderReason;

    await hooks.onPlan?.(planned);
    const start = new Map<string, BodyPose>(scene.ctx.objects.map((o) => [o.name, bodyPose(scene.physics, o.name)]));
    const executed = await hooks.drive(execute(planned.steps, scene.fleet, trace));
    record.executed = executed.map((e) => ({ object: e.step.object, robot: e.step.robot, ok: e.result.ok, reason: e.result.reason }));
    await hooks.settle(SETTLE_S); // let everything come to rest before measuring

    trace({ step: 'verify', state: 'start', text: 'Measuring every object against the after photo' });
    const final = new Map<string, BodyPose>(scene.ctx.objects.map((o) => [o.name, bodyPose(scene.physics, o.name)]));
    const notes = new Map<string, string>();
    for (const r of planned.refusals) notes.set(r.object, `refused: ${r.reason}`);
    for (const e of executed) if (!e.result.ok) notes.set(e.step.object, `failed: ${e.result.reason}`);
    const receipt = measure({
      camera: scene.ctx.camera,
      goals: chosen.check.goals,
      start,
      final,
      meshes: scene.meshes,
      beforeMasks: new Map<string, Rle>(scene.ctx.before.map((b) => [b.object, b.rle])),
      notes,
    });
    record.receipt = receipt;
    record.score = receipt.score;
    trace({ step: 'verify', state: 'done', text: `${receipt.matched}/${receipt.total} objects match the after photo · median error ${receipt.medianErrorCm.toFixed(1)} cm` });

    const render = hooks.render ? await hooks.render() : null;
    if (render) files['render.jpg'] = render;
    if (render && hooks.verdict) {
      trace({ step: 'verdict', state: 'start', text: 'Muse Spark compares the result with the goal' });
      const said = await hooks.verdict({ request, after: chosen.image, render, results: resultLines(receipt), score: receipt.score });
      record.verdict = said.verdict;
      trace({ step: 'verdict', state: 'done', text: said.verdict.verdict, usage: said.usage });
    }
    record.status = 'done';
  } catch (error) {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
    trace({ step: 'verify', state: 'fail', text: record.error });
  }
  return finish();
}
