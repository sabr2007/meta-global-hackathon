// Turns the private desk scan and its saved Ayna runs into the small public assets the landing page
// and the videos use. Everything it writes is committed, so neither the landing nor `npm run render`
// needs the private data.
//
//   npm run prepare-assets                       # source = the repo root (web/public/scenes, data/store)
//   npm run prepare-assets -- --source /path/to/checkout [--scan desk-sam3d] [--run <run id>]
//
// Reads:  the scan's bundle {hero.jpg,masks.json,scene.json} from <source>/data/scenes/<scan>,
//         <source>/web/public/scenes/<scan> or <source>/data/store/scans/*/<scan>/bundle
//         <source>/data/store/scans/*/<scan>/runs/*/{run.json,candidate-*.webp}
// Writes: web/public/landing/before-{720,1080}.webp, after-<run>-<id>-{720,1080}.webp
//         render-<run>-720.webp (the verifier's render of the twin, when saved)
//         twin-<run>.mp4 is not written here: a sped-up screen recording of the robots replaying the run
//         (see video/README.md); when it is in web/public/landing, the film's twin beat plays it
//         web/src/landing/facts/showcase.json (scene facts, dotted mask outlines, the featured run, the others)

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { maskOutline } from './outline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PUBLIC_OUT = path.join(REPO, 'web', 'public', 'landing');
const DATA_OUT = path.join(REPO, 'web', 'src', 'landing', 'facts');

const WIDTHS = [720, 1080];
const QUALITY = { 720: 72, 1080: 74 };
const MAX_BYTES = 200 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const source = path.resolve(arg('source', process.env.AYNA_SOURCE ?? REPO));
const scanId = arg('scan', 'desk-sam3d');
const forcedRun = arg('run', null);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function findRuns() {
  const scans = path.join(source, 'data', 'store', 'scans');
  if (!existsSync(scans)) throw new Error(`no saved runs under ${scans}`);
  const runs = [];
  for (const owner of readdirSync(scans)) {
    const dir = path.join(scans, owner, scanId, 'runs');
    if (!existsSync(dir)) continue;
    for (const id of readdirSync(dir)) {
      const file = path.join(dir, id, 'run.json');
      if (!existsSync(file)) continue;
      const run = readJson(file);
      if (run.status !== 'done' || !run.receipt || !run.chosen) continue;
      const withImages = run.candidates.filter((c) => c.file && existsSync(path.join(dir, id, c.file)));
      runs.push({ dir: path.join(dir, id), run, withImages });
    }
  }
  return runs;
}

// What SAM 3.1 caught, by kind, so the featured run shows as many different rejections as it can.
const REJECTION_KINDS = [/missing|vanished/i, /appeared|extra|added/i, /changed size|size/i, /moved .* should stay/i];

/** A run that shows the whole loop: rejected versions (of different kinds) first, then the receipt. */
function rank({ run, withImages }) {
  const rejected = withImages.filter((c) => !c.passed);
  const reasons = rejected.flatMap((c) => c.reasons ?? []);
  const kinds = REJECTION_KINDS.filter((kind) => reasons.some((r) => kind.test(r))).length;
  const matchShare = run.receipt.total ? run.receipt.matched / run.receipt.total : 0;
  return (rejected.length > 0 ? 1000 : 0) + kinds * 60 + matchShare * 200 + withImages.length;
}

/** Other saved runs on the same scan, without images: what each robot did and what SAM 3.1 caught. */
function summarise({ run }, labels) {
  return {
    id: run.id,
    request: run.request,
    candidates: run.candidates.map((c) => ({ id: c.id, passed: c.passed, reasons: c.reasons ?? [] })),
    executed: run.executed.map((e) => ({ label: labels.get(e.object) ?? e.object, robot: e.robot, ok: e.ok })),
    refusals: [
      ...(run.instruction.refusals ?? []).map((r) => ({ label: labels.get(r.object) ?? r.object, reason: r.reason })),
      ...run.refusals.map((r) => ({ label: r.label, reason: r.reason })),
    ],
    receipt: { matched: run.receipt.matched, total: run.receipt.total },
  };
}

/** Removes earlier featured runs' pictures so only the current one ships. */
function removeStale(keep) {
  for (const file of readdirSync(PUBLIC_OUT)) {
    if (/^(after|render)-.+\.webp$/.test(file) && !keep.has(file)) unlinkSync(path.join(PUBLIC_OUT, file));
  }
}

async function writeWebp(input, base, resize, widths = WIDTHS) {
  const written = {};
  for (const width of widths) {
    const height = Math.round((width * 4) / 3);
    const file = `${base}-${width}.webp`;
    const buffer = await sharp(input).resize(width, height, { fit: resize }).webp({ quality: QUALITY[width], effort: 6 }).toBuffer();
    if (buffer.length > MAX_BYTES) throw new Error(`${file} is ${buffer.length} bytes (budget ${MAX_BYTES})`);
    writeFileSync(path.join(PUBLIC_OUT, file), buffer);
    written[width] = file;
  }
  return written;
}

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The scan's bundle (hero.jpg, masks.json, scene.json), wherever this checkout keeps it. */
function findScene() {
  const scans = path.join(source, 'data', 'store', 'scans');
  const owners = existsSync(scans) ? readdirSync(scans).map((owner) => path.join(scans, owner, scanId, 'bundle')) : [];
  const places = [path.join(source, 'data', 'scenes', scanId), path.join(source, 'web', 'public', 'scenes', scanId), ...owners];
  const found = places.find((dir) => ['hero.jpg', 'masks.json', 'scene.json'].every((f) => existsSync(path.join(dir, f))));
  if (!found) throw new Error(`no bundle for ${scanId}; looked in:\n  ${places.join('\n  ')}`);
  return found;
}

async function main() {
  const sceneDir = findScene();
  const scene = readJson(path.join(sceneDir, 'scene.json'));
  const masks = readJson(path.join(sceneDir, 'masks.json'));
  mkdirSync(PUBLIC_OUT, { recursive: true });
  mkdirSync(DATA_OUT, { recursive: true });

  // The hero photo is 3:4 already; candidates come back from Muse Image at their own size and are
  // stretched onto the hero's pixels, exactly as the app maps their masks (sx, sy in goals.ts).
  const before = await writeWebp(path.join(sceneDir, 'hero.jpg'), 'before', 'fill');

  const runs = findRuns();
  if (!runs.length) throw new Error('no finished runs with a chosen version');
  const featured = forcedRun ? runs.find((r) => r.run.id === forcedRun) : [...runs].sort((a, b) => rank(b) - rank(a))[0];
  if (!featured) throw new Error(`run ${forcedRun} not found`);
  const { run, dir } = featured;

  const candidates = [];
  for (const c of run.candidates) {
    const file = c.file && path.join(dir, c.file);
    const images = file && existsSync(file) ? await writeWebp(file, `after-${run.id}-${c.id}`, 'fill') : null;
    candidates.push({ id: c.id, round: c.round, passed: c.passed, reasons: c.reasons ?? [], notes: c.notes ?? [], images });
  }
  // the verifier's render of the twin from the photo's camera, when the run saved one
  const renderFile = path.join(dir, 'render.jpg');
  const render = existsSync(renderFile) ? await writeWebp(renderFile, `render-${run.id}`, 'fill', [720]) : null;
  removeStale(new Set([...candidates.flatMap((c) => Object.values(c.images ?? {})), ...Object.values(render ?? {})]));

  const labels = new Map(scene.objects.map((o) => [o.name, o.label]));
  const showcase = {
    note: 'Generated by video/scripts/prepare-assets.mjs from a real saved Ayna run. Do not edit by hand.',
    scan: {
      id: scanId,
      device: scene.source.device,
      photos: scene.source.photos,
      depthFrames: scene.source.depth_frames,
      image: { width: masks.width, height: masks.height },
      objects: scene.objects.map((o) => ({
        name: o.name,
        label: o.label,
        sizeCm: o.size_m.map((v) => round(v * 100, 1)),
        fitErrorMm: o.fit_error_mm,
      })),
      before: before,
      outlines: masks.masks.map((m) => ({ object: m.object, label: labels.get(m.object), ...maskOutline(m.rle) })),
    },
    run: {
      id: run.id,
      request: run.request,
      created: run.created,
      editPrompt: run.instruction.edit_prompt,
      summary: run.instruction.summary,
      planRefusals: (run.instruction.refusals ?? []).map((r) => ({ label: labels.get(r.object) ?? r.object, reason: r.reason })),
      candidates,
      chosen: run.chosen,
      judge: {
        reason: run.judgement?.reason ?? '',
        ranking: (run.judgement?.ranking ?? []).map((r) => ({ id: r.id, note: r.note, followsRequest: r.follows_request })),
      },
      judged: run.trace.find((t) => t.step === 'judge' && t.state === 'done')?.text ?? '',
      steps: run.steps.map((s) => ({ label: s.label, robot: s.robot, why: s.why })),
      orderReason: run.orderReason ?? '',
      refusals: run.refusals.map((r) => ({ label: r.label, reason: r.reason })),
      executed: run.executed.map((e) => ({ label: labels.get(e.object) ?? e.object, robot: e.robot, ok: e.ok })),
      receipt: {
        score: run.receipt.score,
        matched: run.receipt.matched,
        total: run.receipt.total,
        medianErrorCm: round(run.receipt.medianErrorCm, 2),
        moved: run.receipt.moved,
        results: run.receipt.results.map((r) => ({
          label: r.label,
          wanted: r.wanted,
          errorCm: round(r.errorM * 100, 2),
          ok: r.ok,
          note: r.note,
        })),
      },
      afterOutlines: run.goals
        .filter((g) => g.found && g.mask)
        .map((g) => ({ object: g.name, label: g.label, moves: g.moves, ...maskOutline(g.mask) })),
      trace: run.trace.map((t) => ({
        at: t.at,
        step: t.step,
        state: t.state,
        text: t.text,
        usage: (t.usage ?? []).map((u) => ({ model: u.model, ms: u.ms, costUsd: u.costUsd ?? null })),
      })),
      verdict: run.verdict ? { matchesRequest: run.verdict.matches_request, text: run.verdict.verdict } : null,
      render,
      twinClip: existsSync(path.join(PUBLIC_OUT, `twin-${run.id}.mp4`)) ? `twin-${run.id}.mp4` : null,
      costUsd: round(run.costUsd, 4),
      seconds: Math.round(run.durationMs / 1000),
    },
    others: runs.filter((r) => r !== featured).map((r) => summarise(r, labels)),
  };
  writeFileSync(path.join(DATA_OUT, 'showcase.json'), `${JSON.stringify(showcase, null, 1)}\n`);
  const shown = candidates.filter((c) => c.images).length;
  console.log(`featured run ${run.id} "${run.request}": ${shown} versions, ${candidates.filter((c) => !c.passed).length} rejected`);
  console.log(`wrote ${path.relative(REPO, PUBLIC_OUT)}/ and ${path.relative(REPO, path.join(DATA_OUT, 'showcase.json'))}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
