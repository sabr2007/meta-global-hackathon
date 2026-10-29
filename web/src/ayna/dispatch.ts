// Turning approved goals into robot steps: the facts Muse Spark plans from, and a check of its plan
// against what the robots can physically do (a plan is never trusted blindly).

import type { FleetRobot } from './fleet';
import type { ObjectGoal, SceneObject } from './goals';

const CLEARANCE_M = 0.015; // two footprints closer than this count as overlapping

/** Points of an object's footprint on the table (from its mask on the real photo), world xy. */
export type Footprints = Map<string, [number, number][]>;

export interface PlannedStep {
  object: string;
  label: string;
  robot: string;
  why: string;
  x: number;
  y: number;
  yawDelta: number;
}

export interface Refusal {
  object: string;
  label: string;
  reason: string;
}

export interface SparkPlan {
  steps: { object: string; robot: string; why: string }[];
  refusals: { object: string; reason: string }[];
  order_reason: string;
}

const cm = (m: number): string => `${(m * 100).toFixed(0)} cm`;

function overlaps(a: [number, number][], shift: [number, number], b: [number, number][]): boolean {
  for (const [ax, ay] of a) {
    for (const [bx, by] of b) {
      if (Math.hypot(ax + shift[0] - bx, ay + shift[1] - by) < CLEARANCE_M) return true;
    }
  }
  return false;
}

export interface PlanFacts {
  moves: string[];
  robots: string[];
  facts: string[];
}

/** What Spark needs to order and assign the moves, all measured from the scan. */
export function planFacts(goals: ObjectGoal[], objects: SceneObject[], fleet: FleetRobot[], footprints: Footprints): PlanFacts {
  const byName = new Map(objects.map((o) => [o.name, o]));
  const moving = goals.filter((g) => g.found && g.moves);
  const moves = moving.map((g) => {
    const o = byName.get(g.name)!;
    const turn = g.yawDelta ? `, turn ${Math.round((g.yawDelta * 180) / Math.PI)}°` : '';
    return `- ${g.name} (${g.label}, ${o.size_m.slice(0, 2).map((v) => (v * 100).toFixed(0)).join(' x ')} cm): from (${g.from[0].toFixed(2)}, ${g.from[1].toFixed(2)}) to (${g.to[0].toFixed(2)}, ${g.to[1].toFixed(2)}), ${cm(g.distanceM)}${turn}`;
  });
  const robots: string[] = [];
  for (const robot of fleet) {
    robots.push(`- robot ${robot.id} (${robot.kind}, ${robot.label}), gripper opens ${cm(robot.gripWidthM)}:`);
    for (const g of moving) {
      const pick = robot.reachOf(g.name);
      const put = robot.reachPoint(g.to[0], g.to[1]);
      const verdict = pick.ok && put.ok ? 'can do it' : `cannot: ${!pick.ok ? `object ${pick.reason}` : `target ${put.reason}`}`;
      robots.push(`    ${g.name}: ${verdict}`);
    }
  }
  const facts: string[] = [];
  for (const g of moving) {
    const mine = footprints.get(g.name);
    if (!mine) continue;
    for (const other of goals) {
      const theirs = footprints.get(other.name);
      if (other.name === g.name || !theirs) continue;
      if (overlaps(mine, [g.to[0] - g.from[0], g.to[1] - g.from[1]], theirs)) {
        facts.push(`- ${g.name}'s target overlaps where ${other.name} stands now${other.moves ? ` (${other.name} also moves away)` : ' (it stays)'}`);
      }
    }
  }
  return { moves, robots, facts };
}

/** Objects that must be moved before each object, because its target covers where they stand now. */
export function blockers(goals: ObjectGoal[], footprints: Footprints): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const g of goals) {
    const mine = footprints.get(g.name);
    if (!g.moves || !mine) continue;
    const shift: [number, number] = [g.to[0] - g.from[0], g.to[1] - g.from[1]];
    const blocking = goals.filter((other) => other.name !== g.name && footprints.has(other.name) && overlaps(mine, shift, footprints.get(other.name)!));
    result.set(g.name, blocking.map((b) => b.name));
  }
  return result;
}

/** Stable topological order: a step waits for the steps that clear its target; cycles keep their order. */
export function orderSteps(steps: PlannedStep[], before: Map<string, string[]>): { steps: PlannedStep[]; moved: string[] } {
  const pending = steps.slice();
  const ordered: PlannedStep[] = [];
  const moved: string[] = [];
  while (pending.length) {
    const waiting = new Set(pending.map((s) => s.object));
    const index = pending.findIndex((s) => !(before.get(s.object) ?? []).some((b) => waiting.has(b) && b !== s.object));
    const next = pending.splice(index >= 0 ? index : 0, 1)[0];
    if (index > 0) moved.push(next.label);
    ordered.push(next);
  }
  return { steps: ordered, moved };
}

/** Keep Spark's order, but only with assignments the robots can carry out and an order that clears
 * every target first; explain every change. */
export function checkPlan(
  plan: SparkPlan,
  goals: ObjectGoal[],
  fleet: FleetRobot[],
  footprints: Footprints = new Map(),
): { steps: PlannedStep[]; refusals: Refusal[]; fixes: string[] } {
  const moving = new Map(goals.filter((g) => g.found && g.moves).map((g) => [g.name, g]));
  const steps: PlannedStep[] = [];
  const refusals: Refusal[] = [];
  const fixes: string[] = [];
  const handled = new Set<string>();
  const capable = (g: ObjectGoal): FleetRobot[] => fleet.filter((r) => r.reachOf(g.name).ok && r.reachPoint(g.to[0], g.to[1]).ok);
  const blocker = (g: ObjectGoal): string =>
    fleet
      .map((r) => {
        const pick = r.reachOf(g.name);
        const put = r.reachPoint(g.to[0], g.to[1]);
        return `${r.label}: ${!pick.ok ? pick.reason : put.reason}`;
      })
      .join('; ');

  for (const step of plan.steps) {
    const goal = moving.get(step.object);
    if (!goal || handled.has(step.object)) continue;
    handled.add(step.object);
    const able = capable(goal);
    let robot = able.find((r) => r.id === step.robot);
    if (!robot && able.length) {
      robot = able[0];
      fixes.push(`${goal.label}: ${step.robot} cannot do it, ${robot.id} can`);
    }
    // The stationary arm needs no driving and places more precisely: it takes every move it can do.
    const arm = able.find((r) => r.kind === 'arm');
    if (robot && robot.kind !== 'arm' && arm) {
      fixes.push(`${goal.label}: the stationary arm can do it, no need to drive`);
      robot = arm;
    }
    if (!robot) {
      refusals.push({ object: goal.name, label: goal.label, reason: blocker(goal) });
      if (fleet.some((r) => r.id === step.robot)) fixes.push(`${goal.label}: no robot can do it`);
      continue;
    }
    steps.push({ object: goal.name, label: goal.label, robot: robot.id, why: step.why, x: goal.to[0], y: goal.to[1], yawDelta: goal.yawDelta });
  }
  for (const refusal of plan.refusals) {
    const goal = moving.get(refusal.object);
    if (!goal || handled.has(refusal.object)) continue;
    handled.add(refusal.object);
    refusals.push({ object: goal.name, label: goal.label, reason: refusal.reason });
  }
  for (const goal of moving.values()) {
    if (handled.has(goal.name)) continue;
    const able = capable(goal);
    if (able.length) {
      const pick = able.find((r) => r.kind === 'arm') ?? able[0];
      steps.push({ object: goal.name, label: goal.label, robot: pick.id, why: 'added: the plan left it out', x: goal.to[0], y: goal.to[1], yawDelta: goal.yawDelta });
      fixes.push(`${goal.label}: missing from the plan, added`);
    } else {
      refusals.push({ object: goal.name, label: goal.label, reason: blocker(goal) });
    }
  }
  const ordered = orderSteps(steps, blockers(goals, footprints));
  for (const label of ordered.moved) fixes.push(`${label}: moved earlier, its spot had to be cleared first`);
  return { steps: ordered.steps, refusals, fixes };
}
