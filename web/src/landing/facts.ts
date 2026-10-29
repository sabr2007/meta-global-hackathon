// The real material behind the page, and the small derivations the sections share.
import evalJson from './facts/eval.json';
import loopJson from './facts/loop.json';
import showcaseJson from './facts/showcase.json';
import type { Candidate, EvalFacts, LoopFacts, Showcase } from './types';

export const showcase: Showcase = showcaseJson;
export const evalFacts: EvalFacts = evalJson;
export const loop: LoopFacts = loopJson;

export const run = showcase.run;
export const scan = showcase.scan;

export const chosen: Candidate = run.candidates.find((c) => c.id === run.chosen) ?? run.candidates[0];

const DEVICES: Record<string, string> = { 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max', 'iPhone15,2': 'iPhone 14 Pro' };
export const deviceName = (id: string): string => DEVICES[id] ?? id;

/** "obj_1_white_keyboard" -> "white keyboard", so logged reasons read like the app shows them. */
export function prettify(text: string): string {
  return text.replace(/obj_\d+_([a-z_]+)/g, (_, name: string) => name.replace(/_/g, ' '));
}

export const sentenceCase = (text: string): string => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** The sentences of Spark's edit that say what moves or stays (no camera boilerplate). */
export function editSentences(limit = 3): string[] {
  return run.editPrompt
    .split(/(?<=\.)\s+/)
    .filter((sentence) => /^(Move|Leave|Put|Place|Turn|Rotate|Stack|Group|Line)\b/.test(sentence))
    .slice(0, limit);
}

/** Labels of the objects the chosen after photo moves. */
export const movedLabels = (): string[] => run.afterOutlines.filter((o) => o.moves).map((o) => o.label ?? o.object);

export function usageOf(step: string, textStart = ''): { ms: number; costUsd: number } | null {
  const entry = run.trace.find((t) => t.step === step && t.state === 'done' && t.text.startsWith(textStart) && t.usage.length);
  if (!entry) return null;
  return {
    ms: entry.usage.reduce((total, u) => total + u.ms, 0),
    costUsd: entry.usage.reduce((total, u) => total + (u.costUsd ?? 0), 0),
  };
}

export const judgeOf = (id: string) => run.judge.ranking.find((r) => r.id === id) ?? null;

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const formatCm = (cm: number): string => (cm < 10 ? cm.toFixed(1) : String(Math.round(cm)));
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;
export const formatSeconds = (ms: number): string => (ms / 1000).toFixed(1);

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export interface Refusal {
  label: string;
  reason: string;
  request: string;
}

/** Refusals from every logged run plus the featured run's planning refusals; measured ones first. */
export function allRefusals(limit = 4): Refusal[] {
  const fromPlan = run.planRefusals.map((r) => ({ label: r.label, reason: r.reason, request: run.request }));
  const fromRuns = evalFacts.list.flatMap((r) =>
    r.refusals.map((text) => {
      const split = text.indexOf(': ');
      return split > 0
        ? { label: prettify(text.slice(0, split)), reason: prettify(text.slice(split + 2)), request: r.request }
        : { label: '', reason: prettify(text), request: r.request };
    }),
  );
  const seen = new Set<string>();
  const measured = (r: Refusal) => (/\d+(\.\d+)?\s?(cm|m)\b/.test(r.reason) ? 0 : 1);
  return [...fromPlan, ...fromRuns]
    .filter((r) => {
      const key = `${r.label}|${r.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => measured(a) - measured(b))
    .slice(0, limit);
}
