// Real material only: the run the landing features (web/src/landing/facts/showcase.json, written by
// scripts/prepare-assets.mjs from a saved Ayna run) and the eval totals (eval.json, from the eval log).
import evalNumbers from '../../web/src/landing/facts/eval.json';
import showcase from '../../web/src/landing/facts/showcase.json';
import captions from './loop/captions.json';

export { evalNumbers, showcase };

export type Size = '720' | '1080';
export type Point = [number, number];

export interface Outline {
  object: string;
  label?: string;
  d: string;
  centroid: number[] | null;
  box: number[];
  moves?: boolean;
}

export interface Candidate {
  id: string;
  round: number;
  passed: boolean;
  reasons: string[];
  notes: string[];
  images: Record<Size, string> | null;
}

export const run = showcase.run;
export const scan = showcase.scan;
export const IMAGE = scan.image; // hero pixels: every outline and centroid is in this space

export const candidates = run.candidates as Candidate[];
export const chosen = candidates.find((c) => c.id === run.chosen) ?? candidates[0];
export const beforeOutlines = scan.outlines as Outline[];
export const afterOutlines = run.afterOutlines as Outline[];

/** "obj_1_white_keyboard" -> "white keyboard", so logged reasons read like the app shows them. */
export function prettify(text: string): string {
  return text.replace(/obj_\d+_([a-z_]+)/g, (_, name: string) => name.replace(/_/g, ' '));
}

/** The sentences of Spark's edit instruction that say what moves or stays (no boilerplate). */
export function editSentences(limit = 3): string[] {
  return run.editPrompt
    .split(/(?<=\.)\s+/)
    .filter((s) => /^(Move|Leave|Put|Place|Turn|Rotate|Stack|Group|Line)\b/.test(s))
    .slice(0, limit);
}

export function judgeScore(id: string): number | null {
  return run.judge.ranking.find((r) => r.id === id)?.followsRequest ?? null;
}

/** Seconds Muse Image took for each version, from the run's trace. */
export function developSeconds(id: string): number | null {
  const entry = run.trace.find((t) => t.step === 'imagine' && t.state === 'done' && t.text.startsWith(`Version ${id} `));
  const ms = entry?.usage.find((u) => u.model.startsWith('muse-image'))?.ms;
  return ms ? ms / 1000 : null;
}

/** Objects the after photo moves: where SAM 3.1 saw them before and where the chosen version puts them. */
export function moves(): { label: string; from: Point; to: Point }[] {
  return afterOutlines
    .filter((o) => o.moves && o.centroid)
    .flatMap((o) => {
      const before = beforeOutlines.find((b) => b.object === o.object);
      if (!before?.centroid) return [];
      return [{ label: o.label ?? o.object, from: before.centroid as Point, to: o.centroid as Point }];
    });
}

/** Every refusal of the run: at planning time (Spark's instruction) and at dispatch (robot checks). */
export function refusals(): { label: string; reason: string }[] {
  const seen = new Set<string>();
  return [...run.refusals, ...run.planRefusals]
    .map((r) => ({ label: prettify(r.label), reason: prettify(r.reason) }))
    .filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)));
}

export const formatCm = (cm: number): string => (cm < 10 ? cm.toFixed(1) : Math.round(cm).toString());
export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

/** On-screen caption of the loop (captions.json), with the featured run's values filled in. */
export function caption(key: string): { chip: string; text: string } {
  const cue = captions.cues.find((c) => c.key === key);
  if (!cue) throw new Error(`no caption ${key}`);
  const values: Record<string, string> = {
    request: run.request,
    objects: String(scan.objects.length),
    versions: String(Math.min(candidates.length, 6)),
  };
  return { chip: cue.chip, text: cue.text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? name) };
}
