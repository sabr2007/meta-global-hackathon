// The scan builder: turns mirrors sent from the iPhone into twins. It runs where the Python
// pipeline runs (it needs uv, MuJoCo and the fal / Meta keys), polls the same private store as the
// server, and publishes each finished bundle back, so the scan shows up as ready in the app.
//
//   cd web && npm run worker              # keep polling (every 15 s)
//   cd web && npm run worker -- --once    # build what is queued, then exit
//
// With BLOB_READ_WRITE_TOKEN in web/.env.local (`vercel env pull`) it serves production; without it,
// the local store in ../data/store.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentType, type ScanMeta } from '../server/routes/scans.js';
import { getJson, putJson, store } from '../server/store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(ROOT, '..');
for (const file of [path.join(ROOT, '.env.local'), path.join(REPO, '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const POLL_MS = 15_000;
const ERROR_CHARS = 240;

interface Job {
  owner: string;
  scan: string;
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    if ((await stat(full)).isDirectory()) out.push(...(await files(full)).map((f) => `${entry}/${f}`));
    else out.push(entry);
  }
  return out;
}

function scan2sim(args: string[]): Promise<{ code: number; log: string }> {
  return new Promise((resolve) => {
    const child = spawn('uv', ['run', 'scan2sim', ...args], { cwd: path.join(REPO, 'pipeline') });
    let log = '';
    const keep = (chunk: Buffer): void => {
      const text = chunk.toString();
      log += text;
      process.stdout.write(text);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => resolve({ code: code ?? 1, log }));
  });
}

async function setStatus(job: Job, patch: Partial<ScanMeta>): Promise<ScanMeta | null> {
  const key = `scans/${job.owner}/${job.scan}/meta.json`;
  const meta = await getJson<ScanMeta>(store(), key);
  if (!meta) return null;
  const next = { ...meta, ...patch };
  await putJson(store(), key, next);
  return next;
}

async function build(job: Job): Promise<void> {
  const id = `${job.owner}-${job.scan}`;
  console.log(`\n▸ ${job.owner}/${job.scan}: building`);
  await setStatus(job, { status: 'processing', error: undefined });
  const zip = await store().getBytes(`uploads/${job.owner}/${job.scan}.zip`);
  if (!zip) {
    await setStatus(job, { status: 'failed', error: 'The upload never arrived' });
    return;
  }
  const uploads = path.join(REPO, 'data', 'uploads');
  await mkdir(uploads, { recursive: true });
  const zipPath = path.join(uploads, `${id}.zip`);
  await writeFile(zipPath, zip);
  const out = path.join(REPO, 'data', 'scenes', id);
  const started = Date.now();
  const { code, log } = await scan2sim(['objects', zipPath, '--cache', path.join(REPO, 'data', 'cache', id), '--out', out]);
  if (code !== 0) {
    const last = log.trim().split('\n').filter(Boolean).at(-1) ?? 'scan2sim failed';
    await setStatus(job, { status: 'failed', error: last.slice(0, ERROR_CHARS) });
    console.log(`✗ ${id}: ${last}`);
    return;
  }
  for (const file of await files(out)) {
    await store().putBytes(`scans/${job.owner}/${job.scan}/bundle/${file}`, new Uint8Array(await readFile(path.join(out, file))), contentType(file));
  }
  const scene = JSON.parse(await readFile(path.join(out, 'scene.json'), 'utf8')) as { objects?: unknown[]; robots?: unknown[]; arm?: unknown };
  await setStatus(job, {
    status: 'ready',
    objects: scene.objects?.length ?? 0,
    robots: scene.robots?.length ?? (scene.arm ? 1 : 0),
  });
  console.log(`✓ ${id}: ready in ${Math.round((Date.now() - started) / 1000)} s`);
}

async function drain(): Promise<number> {
  const keys = (await store().list('queue/')).filter((k) => k.endsWith('.json'));
  for (const key of keys) {
    const job = await getJson<Job>(store(), key);
    await store().remove(key); // taken: a crash leaves the scan "processing" rather than building twice
    if (!job) continue;
    try {
      await build(job);
    } catch (error) {
      await setStatus(job, { status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, ERROR_CHARS) });
    }
  }
  return keys.length;
}

async function main(): Promise<void> {
  console.log(`scan builder · store: ${store().kind}`);
  const once = process.argv.includes('--once');
  do {
    const built = await drain();
    if (once) {
      console.log(built ? `built ${built} scan(s)` : 'queue is empty');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (true);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
