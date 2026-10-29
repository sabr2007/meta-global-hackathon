// A whole Ayna run from a sentence to a receipt, with hooks where the browser waits for a person
// (approve the after photo) or shows things (render), and where Node drives the physics itself.

import type { TriangleMesh } from './glb';
import type { FleetRobot } from './fleet';
import type { SceneObject } from './goals';
import { newRunId, type RunRecord } from './record';
import type { Rle } from './rle';
import { dispatch, dispatchGoals, execute, imagineAfter, type Candidate, type Dispatch, type Imagined, type Instruction, type Models, type RunOptions, type SceneContext, type Trace, type TraceEvent, DEFAULT_OPTIONS } from './run';
import { bodyPose, measure, type BodyPose, type Receipt } from './verify';
import type { Physics } from '../sim/physics';

export interface SceneRuntime {
  ctx: SceneContext;
  physics: Physics;
  fleet: FleetRobot[];
  meshes: Map<string, TriangleMesh>;
}

const PERSON_REDRAWS = 1; // how many times "Not this, because …" sends the after photo back to be drawn again

export interface RunHooks {
  /** The person's answer to the after photo: true for Spark's pick, the id of another version that passed to
   * plan from that one instead, { redraw: reason } to have it drawn again, false to stop. */
  approve(imagined: Imagined): Promise<boolean | string | { redraw: string }>;
  drive<T>(work: Promise<T>): Promise<T>;
  /** Let the simulation run for a while (objects come to rest). */
  settle(seconds: number): Promise<void>;
  /** The checked plan, before the robots start (the browser shows it and flies into the twin). */
  onPlan?(planned: Dispatch): Promise<void>;
  render?(): Promise<string | null>;
  verdict?(input: { request: string; after: string; render?: string; results: string[]; score: number }): Promise<{ verdict: { verdict: string; matches_request: boolean }; usage: TraceEvent['usage'] }>;
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

export function receiptLine(receipt: Receipt): string {
  const overlap = receipt.overlap === null ? '' : ` · contours overlap ${Math.round(receipt.overlap * 100)}%${receipt.photoMedianErrorCm === null || receipt.photoMedianErrorCm === undefined ? '' : `, ${receipt.photoMedianErrorCm.toFixed(1)} cm apart in the photo`}`;
  return `${receipt.moved.done}/${receipt.moved.asked} moves done · ${receipt.stayed.kept}/${receipt.stayed.total} others left in place · moved objects off by ${receipt.medianErrorCm.toFixed(1)} cm (median)${overlap}`;
}

/** Moves the request implied that Spark kept out of the edit because no robot could do them, by object
 * name (Spark may name an object by its label). */
export function refusedInEdit(instruction: Instruction, objects: SceneObject[]): Map<string, string> {
  const byKey = new Map(objects.flatMap((o) => [[o.name, o.name] as const, [o.label.toLowerCase(), o.name] as const]));
  return new Map(
    instruction.refusals.flatMap((r) => {
      const name = byKey.get(r.object) ?? byKey.get(r.object.toLowerCase());
      return name ? [[name, r.reason] as const] : [];
    }),
  );
}

export function resultLines(receipt: Receipt): string[] {
  return receipt.results.map((r) =>
    /^refused before the edit/.test(r.note)
      ? `- ${r.label}: the request implied a move, but no robot could do it, so the edit left it where it was (${r.note.replace(/^refused before the edit: /, '')})`
      : resultLine(r),
  );
}

function resultLine(r: Receipt['results'][number]): string {
  return (
    `- ${r.label}: ${r.wanted === 'move' ? 'should move' : 'should stay'}, off by ${(r.errorM * 100).toFixed(1)} cm${r.headingErrorDeg !== null ? `, heading off ${r.headingErrorDeg.toFixed(0)}°` : ''}, ${r.ok ? 'matches' : 'does not match'}${r.note ? ` (${r.note})` : ''}`
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
    const keep = (candidate: Candidate): void => {
      record.chosen = candidate.id;
      record.thumb = record.candidates.find((c) => c.id === candidate.id)!.file;
      record.goals = candidate.check.goals.map((g) => ({ name: g.name, label: g.label, found: g.found, moves: g.moves, from: g.from, to: g.to, yawDelta: g.yawDelta, distanceM: g.distanceM, mask: g.mask }));
    };
    let from: { round: number; feedback?: string } = { round: 1 };
    let approved: Awaited<ReturnType<RunHooks['approve']>> = false;
    for (let asked = 0; ; asked += 1) {
      imagined = await imagineAfter(scene.ctx, request, scene.fleet, models, trace, options, from);
      record.instruction = imagined.instruction;
      record.feedback.push(...imagined.feedback);
      for (const c of imagined.candidates) {
        const file = `candidate-${c.id}.${extension(c.image)}`;
        files[file] = c.image;
        record.candidates.push({ id: c.id, round: c.round, file, width: c.width, height: c.height, passed: c.check.passed, reasons: c.check.reasons, notes: c.check.notes });
      }
      if (!imagined.chosen) {
        record.status = 'no-after';
        return finish();
      }
      keep(imagined.chosen);
      record.judgement = imagined.judgement;
      approved = await hooks.approve(imagined);
      // "Not this, because …": Spark rewrites the edit with the person's note and Muse Image draws again (once).
      if (typeof approved === 'object' && asked < PERSON_REDRAWS) {
        trace({ step: 'judge', state: 'info', text: `You turned it down: ${approved.redraw}` });
        from = { round: Math.max(...imagined.candidates.map((c) => c.round)) + 1, feedback: `the person turned the after photo down: ${approved.redraw}` };
        continue;
      }
      break;
    }
    if (!approved || typeof approved === 'object') {
      record.status = 'failed';
      record.error = 'Not approved';
      return finish();
    }
    let chosen = imagined.chosen;
    const picked = typeof approved === 'string' ? imagined.candidates.find((c) => c.id === approved && c.check.passed) : undefined;
    if (picked && picked.id !== chosen.id) {
      trace({ step: 'judge', state: 'info', text: `You picked version ${picked.id} over Muse Spark's ${chosen.id}` });
      chosen = picked;
      imagined = { ...imagined, chosen };
      keep(chosen);
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
    const notes = new Map<string, string>();
    for (const r of planned.refusals) notes.set(r.object, `refused: ${r.reason}`);
    const refusedBefore = refusedInEdit(imagined.instruction, scene.ctx.objects);
    for (const e of executed) if (!e.result.ok) notes.set(e.step.object, `failed: ${e.result.reason}`);
    const measureNow = (): Receipt =>
      measure({
        camera: scene.ctx.camera,
        goals: chosen.check.goals,
        start,
        final: new Map<string, BodyPose>(scene.ctx.objects.map((o) => [o.name, bodyPose(scene.physics, o.name)])),
        meshes: scene.meshes,
        beforeMasks: new Map<string, Rle>(scene.ctx.before.map((b) => [b.object, b.rle])),
        notes,
        refusedBefore,
      });
    let receipt = measureNow();

    // Close the loop once: objects a robot handled but that ended off goal get a second plan from
    // where they are now (refused ones would only be refused again).
    // Only objects a robot moved (it reported success, or the grasp slipped) are worth a second try;
    // a placement the robot refused would be refused again.
    const retryable = new Set(executed.filter((e) => e.result.ok || /slipped|missed/i.test(e.result.reason)).map((e) => e.step.object));
    const missed = receipt.results.filter((r) => r.wanted === 'move' && !r.ok && retryable.has(r.name));
    if (missed.length) {
      trace({ step: 'verify', state: 'info', text: `${missed.map((m) => m.label).join(', ')} ended off goal; planning a second pass from where ${missed.length === 1 ? 'it is' : 'they are'}` });
      const retry = chosen.check.goals
        .filter((g) => missed.some((m) => m.name === g.name))
        .map((g) => ({ ...g, from: bodyPose(scene.physics, g.name).position, moves: true }));
      const again = await dispatchGoals(scene.ctx, request, retry, scene.fleet, models, trace, 'Second pass · ');
      await hooks.onPlan?.(again);
      const executedAgain = await hooks.drive(execute(again.steps, scene.fleet, trace));
      await hooks.settle(SETTLE_S);
      for (const e of executedAgain) notes.set(e.step.object, e.result.ok ? '' : `failed again: ${e.result.reason}`);
      record.steps = [...record.steps, ...again.steps];
      record.executed = [...record.executed, ...executedAgain.map((e) => ({ object: e.step.object, robot: e.step.robot, ok: e.result.ok, reason: e.result.reason }))];
      receipt = measureNow();
    }
    record.receipt = receipt;
    record.score = receipt.score;
    trace({ step: 'verify', state: 'done', text: receiptLine(receipt) });

    const render = hooks.render ? await hooks.render() : null;
    if (render) files['render.jpg'] = render;
    if (hooks.verdict) {
      trace({ step: 'verdict', state: 'start', text: 'Muse Spark compares the result with the goal' });
      const said = await hooks.verdict({ request, after: chosen.image, render: render ?? undefined, results: resultLines(receipt), score: receipt.score });
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
