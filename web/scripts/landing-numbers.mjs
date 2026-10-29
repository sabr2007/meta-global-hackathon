// The landing page's live numbers, from the eval log: one JSON line per headless run of the whole
// Ayna loop (live Meta models, MuJoCo robots, the app's verifier), written by scripts/eval.ts.
//
//   node scripts/landing-numbers.mjs [path/to/eval-runs.jsonl]     (default: ../.night/eval-runs.jsonl)
//
// Writes src/landing/facts/eval.json, which the landing bundles at build time. No dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(process.argv[2] ?? path.join(WEB, '..', '.night', 'eval-runs.jsonl'));
const output = path.join(WEB, 'src', 'landing', 'facts', 'eval.json');

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sum = (values) => values.reduce((a, b) => a + b, 0);
const round = (value, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

const lines = readFileSync(input, 'utf8').split('\n').filter((line) => line.trim());
const all = lines.map((line, i) => {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${input}:${i + 1} is not JSON`);
  }
});
const runs = all.filter((r) => r.status === 'done' && !r.error && typeof r.total === 'number' && r.total > 0);
if (!runs.length) throw new Error(`no finished runs in ${input}`);

const numbers = {
  source: 'Headless runs of the full Ayna loop: live Meta models, robots in MuJoCo, the same verifier as the app (web/scripts/eval.ts).',
  generated: new Date().toISOString(),
  runs: runs.length,
  attempted: all.length,
  scans: [...new Set(runs.map((r) => r.scan))],
  requests: [...new Set(runs.map((r) => r.request))],
  objects: { checked: sum(runs.map((r) => r.total)), matched: sum(runs.map((r) => r.matched)) },
  medianErrorCm: {
    median: round(median(runs.map((r) => r.medianErrorCm))),
    min: round(Math.min(...runs.map((r) => r.medianErrorCm))),
    max: round(Math.max(...runs.map((r) => r.medianErrorCm))),
  },
  versions: { developed: sum(runs.map((r) => r.candidates)), rejected: sum(runs.map((r) => r.rejected)) },
  moves: { asked: sum(runs.map((r) => r.moved.asked)), done: sum(runs.map((r) => r.moved.done)) },
  refusals: { count: sum(runs.map((r) => r.refusals.length)), runsWithRefusals: runs.filter((r) => r.refusals.length).length },
  failedSteps: sum(runs.map((r) => r.failedSteps.length)),
  score: { median: median(runs.map((r) => r.score)) },
  costUsd: { median: round(median(runs.map((r) => r.costUsd)), 3), total: round(sum(runs.map((r) => r.costUsd)), 2) },
  seconds: {
    median: Math.round(median(runs.map((r) => r.seconds))),
    min: Math.min(...runs.map((r) => r.seconds)),
    max: Math.max(...runs.map((r) => r.seconds)),
  },
  list: runs.map((r) => ({
    run: r.run,
    scan: r.scan,
    request: r.request,
    score: r.score,
    matched: r.matched,
    total: r.total,
    medianErrorCm: round(r.medianErrorCm),
    candidates: r.candidates,
    rejected: r.rejected,
    refusals: r.refusals,
    seconds: r.seconds,
    costUsd: round(r.costUsd, 3),
  })),
};

writeFileSync(output, `${JSON.stringify(numbers, null, 1)}\n`);
console.log(`${runs.length} runs (${all.length} in the log) -> ${path.relative(process.cwd(), output)}`);
