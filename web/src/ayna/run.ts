// One Ayna run, model by model. Everything here is plain TypeScript (no DOM), so the browser and the
// Node eval share it; `trace` reports each step (which model, what it did, how long, what it cost).

import type { PhotoCamera } from './camera';
import { checkPlan, planFacts, type PlannedStep, type Refusal, type SparkPlan } from './dispatch';
import type { FleetRobot, StepResult } from './fleet';
import { checkCandidate, conceptCounts, footprint, type BeforeMask, type CandidateCheck, type ObjectGoal, type SceneObject, type Segmented } from './goals';
import { imageSize } from './images';

export interface Usage {
  model: string;
  ms: number;
  costUsd: number;
}

export interface SceneObjectBrief {
  name: string;
  label: string;
  concept: string;
  size_cm: [number, number, number];
  where: string;
  reach: string[];
}

export interface Instruction {
  request_en: string;
  edit_prompt: string;
  moves: { object: string; action: 'move' | 'stay'; where: string }[];
  refusals: { object: string; reason: string }[];
  summary: string;
}

export interface Judgement {
  best: string;
  reason: string;
  ranking: { id: string; follows_request: number; plausible: number; note: string }[];
}

/** The server's model endpoints (see server/router.ts). */
export interface Models {
  instruct(input: { request: string; photo: string; objects: SceneObjectBrief[]; robots: string[]; feedback?: string }): Promise<{ instruction: Instruction; usage: Usage[] }>;
  imagine(input: { photo: string; prompt: string }): Promise<{ image: string; usage: Usage[] }>;
  segment(input: { image: string; width: number; height: number; objects: { name: string; concept: string; label: string }[] }): Promise<{ objects: Segmented[]; usage: Usage[] }>;
  judge(input: { request: string; prompt: string; before: string; candidates: { id: string; image: string; facts: string }[] }): Promise<{ judgement: Judgement; usage: Usage[] }>;
  plan(input: { request: string; moves: string[]; robots: string[]; facts: string[] }): Promise<{ plan: SparkPlan; usage: Usage[] }>;
}

export type Step = 'listen' | 'instruct' | 'imagine' | 'check' | 'judge' | 'plan' | 'execute' | 'verify' | 'verdict';

export interface TraceEvent {
  step: Step;
  state: 'start' | 'done' | 'fail' | 'info';
  text: string;
  usage?: Usage[];
  candidate?: string;
  image?: string; // a developed version (live only; not saved in the run's trace)
  check?: { passed: boolean; reasons: string[] };
}

export type Trace = (event: TraceEvent) => void;

export interface SceneContext {
  camera: PhotoCamera;
  photo: string; // hero photo as a data URL (what the models see)
  objects: SceneObject[];
  before: BeforeMask[];
}

export interface Candidate {
  id: string;
  round: number;
  image: string;
  width: number;
  height: number;
  check: CandidateCheck;
}

export interface Imagined {
  instruction: Instruction;
  feedback: string[]; // why each earlier round was redone
  candidates: Candidate[];
  chosen: Candidate | null;
  judgement: Judgement | null;
}

export interface RunOptions {
  candidates: number;
  rounds: number;
}

export const DEFAULT_OPTIONS: RunOptions = { candidates: 3, rounds: 2 };

const total = (usage: Usage[]): { ms: number; costUsd: number } => ({
  ms: Math.max(0, ...usage.map((u) => u.ms)),
  costUsd: usage.reduce((s, u) => s + u.costUsd, 0),
});

function where(camera: PhotoCamera, mask: BeforeMask): string {
  const [x, y] = [mask.rle.x + mask.rle.w / 2, mask.rle.y + mask.rle.h / 2];
  const column = x < camera.width / 3 ? 'left' : x > (2 * camera.width) / 3 ? 'right' : 'centre';
  const row = y < camera.height / 3 ? 'back' : y > (2 * camera.height) / 3 ? 'front' : 'middle';
  return `${row} ${column} of the photo`;
}

export function briefs(ctx: SceneContext, fleet: FleetRobot[]): SceneObjectBrief[] {
  return ctx.objects.map((o) => {
    const mask = ctx.before.find((m) => m.object === o.name);
    return {
      name: o.name,
      label: o.label,
      concept: o.concept,
      size_cm: o.size_m.map((v) => Math.round(v * 1000) / 10) as [number, number, number],
      where: mask ? where(ctx.camera, mask) : 'on the table',
      reach: fleet.some((r) => r.reachOf(o.name).ok)
        ? fleet.map((r) => {
            const reach = r.reachOf(o.name);
            return `${r.label}: ${reach.ok ? 'reaches it' : reach.reason}`;
          })
        : [`MUST STAY: no robot can move it (${fleet.map((r) => `${r.label}: ${r.reachOf(o.name).reason}`).join('; ')})`],
    };
  });
}

export function robotLines(fleet: FleetRobot[]): string[] {
  return fleet.map((r) => `- ${r.label} (${r.kind}): gripper opens ${(r.gripWidthM * 100).toFixed(0)} cm`);
}

function candidateFacts(c: Candidate): string {
  const moved = c.check.goals.filter((g) => g.moves).map((g) => `${g.label} ${(g.distanceM * 100).toFixed(0)} cm`);
  return moved.length ? `moves ${moved.join(', ')}; ${c.check.notes.filter((n) => n.includes('drift') || n.includes('stayed')).join('; ')}` : 'nothing moved';
}

/** Steps 1-4: Spark writes the edit, Muse Image draws candidates, SAM 3.1 checks them, Spark judges. */
export async function imagineAfter(ctx: SceneContext, request: string, fleet: FleetRobot[], models: Models, trace: Trace, options = DEFAULT_OPTIONS): Promise<Imagined> {
  const segmentList = ctx.objects.map((o) => ({ name: o.name, concept: o.concept, label: o.label }));
  // Instances per concept on the real photo: the baseline for "an extra object appeared".
  const baseline = models.segment({ image: ctx.photo, width: ctx.camera.width, height: ctx.camera.height, objects: segmentList });
  const counts = baseline.then((b) => {
    trace({ step: 'check', state: 'info', text: 'SAM 3.1 found every object on the real photo', usage: b.usage });
    return conceptCounts(ctx.objects, b.objects);
  });
  const objectBriefs = briefs(ctx, fleet);
  const feedback: string[] = [];
  const candidates: Candidate[] = [];
  let instruction: Instruction | null = null;

  for (let round = 1; round <= options.rounds; round += 1) {
    trace({ step: 'instruct', state: 'start', text: round === 1 ? 'Muse Spark is writing the edit for this photo' : 'Muse Spark is rewriting the edit' });
    const instructed = await models.instruct({ request, photo: ctx.photo, objects: objectBriefs, robots: robotLines(fleet), feedback: feedback.at(-1) });
    instruction = instructed.instruction;
    trace({ step: 'instruct', state: 'done', text: instruction.edit_prompt, usage: instructed.usage });
    const intent = new Map(instruction.moves.map((m) => [m.object, m.action]));

    trace({ step: 'imagine', state: 'start', text: `Muse Image is developing ${options.candidates} versions of the after photo` });
    const drawn = await Promise.all(
      Array.from({ length: options.candidates }, async (_, i): Promise<Candidate | null> => {
        const id = `${round}${String.fromCharCode(97 + i)}`; // 1a, 1b, ...
        try {
          const { image, usage } = await models.imagine({ photo: ctx.photo, prompt: instruction!.edit_prompt });
          trace({ step: 'imagine', state: 'done', text: `Version ${id} developed`, usage, candidate: id, image });
          const size = await imageSize(image);
          trace({ step: 'check', state: 'start', text: `SAM 3.1 is looking for every object in version ${id}`, candidate: id });
          const segmented = await models.segment({ image, width: size.width, height: size.height, objects: segmentList });
          const check = checkCandidate({
            camera: ctx.camera,
            objects: ctx.objects,
            before: ctx.before,
            segmented: segmented.objects,
            imageSize: size,
            beforeCounts: await counts,
            intent,
          });
          const verdict = check.passed ? `Version ${id} keeps all ${ctx.objects.length} objects` : `Version ${id} rejected: ${check.reasons.join('; ')}`;
          trace({ step: 'check', state: check.passed ? 'done' : 'fail', text: verdict, usage: segmented.usage, candidate: id, check: { passed: check.passed, reasons: check.reasons } });
          return { id, round, image, ...size, check };
        } catch (error) {
          trace({ step: 'imagine', state: 'fail', text: `Version ${id} failed: ${error instanceof Error ? error.message : String(error)}`, candidate: id });
          return null;
        }
      }),
    );
    const roundCandidates = drawn.filter((c): c is Candidate => c !== null);
    candidates.push(...roundCandidates);
    const passed = roundCandidates.filter((c) => c.check.passed);
    if (passed.length === 1) {
      trace({ step: 'judge', state: 'done', text: `Only version ${passed[0].id} passed the check` });
      return { instruction, feedback, candidates, chosen: passed[0], judgement: null };
    }
    if (passed.length > 1) {
      trace({ step: 'judge', state: 'start', text: `Muse Spark is choosing between ${passed.length} versions` });
      const judged = await models.judge({
        request,
        prompt: instruction.edit_prompt,
        before: ctx.photo,
        candidates: passed.map((c) => ({ id: c.id, image: c.image, facts: candidateFacts(c) })),
      });
      const chosen = passed.find((c) => c.id === judged.judgement.best) ?? passed[0];
      trace({ step: 'judge', state: 'done', text: `Version ${chosen.id}: ${judged.judgement.reason}`, usage: judged.usage });
      return { instruction, feedback, candidates, chosen, judgement: judged.judgement };
    }
    const reasons = [...new Set(roundCandidates.flatMap((c) => c.check.reasons))];
    feedback.push(reasons.length ? reasons.join('; ') : 'the image model failed to answer');
    trace({ step: 'judge', state: 'fail', text: round < options.rounds ? `No version passed (${feedback.at(-1)}); drawing again` : 'No version passed the check' });
  }
  return { instruction: instruction!, feedback, candidates, chosen: null, judgement: null };
}

export interface Dispatch {
  steps: PlannedStep[];
  refusals: Refusal[];
  fixes: string[];
  orderReason: string;
}

/** Step 5: Spark orders the moves and picks a robot for each; the plan is checked against reach. */
export function dispatch(ctx: SceneContext, request: string, chosen: Candidate, fleet: FleetRobot[], models: Models, trace: Trace): Promise<Dispatch> {
  return dispatchGoals(ctx, request, chosen.check.goals, fleet, models, trace);
}

export async function dispatchGoals(ctx: SceneContext, request: string, goals: ObjectGoal[], fleet: FleetRobot[], models: Models, trace: Trace, label = ''): Promise<Dispatch> {
  const footprints = new Map(
    ctx.before.map((b) => {
      const object = ctx.objects.find((o) => o.name === b.object);
      return [b.object, object ? footprint(ctx.camera, b.rle, object.start[2] - object.size_m[2] / 2) : []] as [string, [number, number][]];
    }),
  );
  const facts = planFacts(goals, ctx.objects, fleet, footprints);
  if (!facts.moves.length) {
    trace({ step: 'plan', state: 'done', text: 'Nothing needs to move' });
    return { steps: [], refusals: [], fixes: [], orderReason: '' };
  }
  trace({ step: 'plan', state: 'start', text: `${label}Muse Spark is ordering ${facts.moves.length} move${facts.moves.length === 1 ? '' : 's'} across ${fleet.length} robot${fleet.length > 1 ? 's' : ''}` });
  const planned = await models.plan({ request, ...facts });
  const checked = checkPlan(planned.plan, goals, fleet, footprints);
  const summary = [
    `${checked.steps.length} step${checked.steps.length === 1 ? '' : 's'}`,
    checked.refusals.length ? `${checked.refusals.length} refused` : '',
    planned.plan.order_reason,
  ].filter(Boolean);
  trace({ step: 'plan', state: 'done', text: label + summary.join(' · '), usage: planned.usage });
  return { ...checked, orderReason: planned.plan.order_reason };
}

export interface Executed {
  step: PlannedStep;
  result: StepResult;
}

/** Step 6: the robots carry out the steps one by one (physics is advanced by the caller). */
export async function execute(steps: PlannedStep[], fleet: FleetRobot[], trace: Trace): Promise<Executed[]> {
  const done: Executed[] = [];
  for (const step of steps) {
    const robot = fleet.find((r) => r.id === step.robot)!;
    trace({ step: 'execute', state: 'start', text: `${robot.label}: ${step.label}` });
    let result = await robot.run({ object: step.object, x: step.x, y: step.y, yawDelta: step.yawDelta });
    if (!result.ok && /slipped|missed/i.test(result.reason)) {
      trace({ step: 'execute', state: 'info', text: `${robot.label}: ${step.label} — ${result.reason}; trying the grasp once more` });
      result = await robot.run({ object: step.object, x: step.x, y: step.y, yawDelta: step.yawDelta });
    }
    trace({ step: 'execute', state: result.ok ? 'done' : 'fail', text: `${robot.label}: ${step.label} — ${result.reason}` });
    done.push({ step, result });
  }
  return done;
}

export function costOf(usage: Usage[]): number {
  return total(usage).costUsd;
}
