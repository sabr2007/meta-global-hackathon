// The landing page's live numbers, from the eval log: one JSON line per headless run of the whole
// Ayna loop (live Meta models, MuJoCo robots, the app's verifier), written by scripts/eval.ts.
//
//   node scripts/landing-numbers.mjs [path/to/eval-runs.jsonl] [--scan desk-sam3d|all] [--since ISO-time]
//     default log: ../.night/eval-runs.jsonl; default scan: desk-sam3d (the only scan shown in public)
//
// Writes src/landing/facts/eval.json, which the landing bundles at build time. No dependencies.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const input = path.resolve(positional[0] ?? path.join(WEB, '..', '.night', 'eval-runs.jsonl'));
const scan = flag('scan', 'desk-sam3d');
const since = flag('since', ''); // only runs of the current system, e.g. the last eval round
const output = path.join(WEB, 'src', 'landing', 'facts', 'eval.json');

// The page is in English: a request spoken in Russian is listed by its language, not its words.
const CYRILLIC = /[\u0400-\u04ff]/;
const english = (request) => (CYRILLIC.test(request) ? 'A request asked in Russian' : request);

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const sum = (values) => values.reduce((a, b) => a + b, 0);
const round = (value, digits = 2) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

const lines = readFileSync(input, 'utf8').split('\n').filter((line) => line.trim());
const logged = lines.map((line, i) => {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${input}:${i + 1} is not JSON`);
  }
});
const all = logged.filter((r) => (scan === 'all' || r.scan === scan) && (!since || (r.at ?? '') >= since));
// done: robots ran and the verifier measured; no-after: SAM 3.1 rejected every version, nothing moved
const done = all.filter((r) => r.status === 'done' && !r.error && typeof r.total === 'number' && r.total > 0);
const stopped = all.filter((r) => r.status === 'no-after' && !r.error);
if (!done.length) throw new Error(`no finished runs for ${scan} in ${input}`);
const finished = [...done, ...stopped];

const numbers = {
  source: 'Headless runs of the full Ayna loop: live Meta models, robots in MuJoCo, the same verifier as the app (web/scripts/eval.ts).',
  generated: new Date().toISOString(),
  scan,
  runs: done.length,
  stopped: stopped.length,
  attempted: all.length,
  scans: [...new Set(finished.map((r) => r.scan))],
  requests: [...new Set(finished.map((r) => english(r.request)))],
  objects: { checked: sum(done.map((r) => r.total)), matched: sum(done.map((r) => r.matched)) },
  medianErrorCm: {
    median: round(median(done.map((r) => r.medianErrorCm))),
    min: round(Math.min(...done.map((r) => r.medianErrorCm))),
    max: round(Math.max(...done.map((r) => r.medianErrorCm))),
  },
  versions: { developed: sum(finished.map((r) => r.candidates)), rejected: sum(finished.map((r) => r.rejected)) },
  moves: { asked: sum(done.map((r) => r.moved.asked)), done: sum(done.map((r) => r.moved.done)) },
  refusals: { count: sum(done.map((r) => r.refusals.length)), runsWithRefusals: done.filter((r) => r.refusals.length).length },
  failedSteps: sum(done.map((r) => r.failedSteps.length)),
  costUsd: { median: round(median(done.map((r) => r.costUsd)), 3), total: round(sum(finished.map((r) => r.costUsd)), 2) },
  seconds: {
    median: Math.round(median(done.map((r) => r.seconds))),
    min: Math.min(...done.map((r) => r.seconds)),
    max: Math.max(...done.map((r) => r.seconds)),
  },
  list: finished.map((r) => ({
    run: r.run,
    scan: r.scan,
    status: r.status,
    request: english(r.request),
    matched: r.matched ?? null,
    total: r.total ?? null,
    medianErrorCm: typeof r.medianErrorCm === 'number' ? round(r.medianErrorCm) : null,
    candidates: r.candidates,
    rejected: r.rejected,
    refusals: r.refusals ?? [],
    seconds: r.seconds,
    costUsd: round(r.costUsd, 3),
  })),
};

writeFileSync(output, `${JSON.stringify(numbers, null, 1)}\n`);
console.log(`${scan}: ${done.length} measured runs, ${stopped.length} stopped before any robot moved (${logged.length} lines in the log) -> ${path.relative(process.cwd(), output)}`);
