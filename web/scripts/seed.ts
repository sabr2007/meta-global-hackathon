// Load scene bundles into the private store and create the accounts that may open them.
//
//   npx tsx scripts/seed.ts --owner you@example.com:PASSWORD --member judge@example.com:PASSWORD \
//     --scan desk-sam3d="Desk" --scan mirror02-sam3d="Mirror 02" [--demo desk-sam3d] [--runs-from ../data/store]
//
// Uses the private Vercel Blob store when BLOB_READ_WRITE_TOKEN is set (e.g. after `vercel env pull`),
// otherwise ../data/store on disk. Bundles are read from ../data/scenes/<id> or public/scenes/<id>.

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createUser, type User } from '../server/auth';
import { contentType, type ScanMeta } from '../server/routes/scans';
import { putJson, store } from '../server/store';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const file of [path.join(ROOT, '.env.local'), path.join(ROOT, '..', '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

function args(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === `--${name}` && process.argv[i + 1]) values.push(process.argv[i + 1]);
  });
  return values;
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

async function account(spec: string, role: User['role']): Promise<User> {
  const at = spec.lastIndexOf(':');
  const [email, password] = [spec.slice(0, at), spec.slice(at + 1)];
  return createUser(email, password, email.split('@')[0], role);
}

async function main(): Promise<void> {
  const ownerSpec = args('owner')[0];
  if (!ownerSpec) throw new Error('pass --owner email:password');
  const owner = await account(ownerSpec, 'owner');
  const members = await Promise.all(args('member').map((spec) => account(spec, 'judge')));
  console.log(`store: ${store().kind}; owner ${owner.email} (${owner.id}); members ${members.map((m) => `${m.email} (${m.id})`).join(', ') || '-'}`);
  for (const spec of args('scan')) {
    const [id, name = id] = spec.split('=');
    const dir = [path.join(ROOT, '..', 'data', 'scenes', id), path.join(ROOT, 'public', 'scenes', id)].find((d) => existsSync(d));
    if (!dir) throw new Error(`no bundle for ${id}`);
    const scene = JSON.parse(await readFile(path.join(dir, 'scene.json'), 'utf8'));
    for (const file of await files(dir)) {
      await store().putBytes(`scans/${owner.id}/${id}/bundle/${file}`, new Uint8Array(await readFile(path.join(dir, file))), contentType(file));
    }
    const meta: ScanMeta = {
      id,
      owner: owner.id,
      name,
      created: scene.source?.captured_at ?? new Date().toISOString(),
      status: 'ready',
      objects: (scene.objects ?? []).length,
      robots: (scene.robots ?? (scene.arm ? [scene.arm] : [])).length,
      members: members.map((m) => m.id),
    };
    await putJson(store(), `scans/${owner.id}/${id}/meta.json`, meta);
    console.log(`scan ${id}: ${meta.objects} objects, uploaded from ${path.relative(ROOT, dir)}`);
    const runsFrom = args('runs-from')[0];
    const runsDir = runsFrom ? path.resolve(ROOT, runsFrom, 'scans', owner.id, id, 'runs') : null;
    if (runsDir && existsSync(runsDir)) {
      const runFiles = await files(runsDir);
      for (const file of runFiles) {
        await store().putBytes(`scans/${owner.id}/${id}/runs/${file}`, new Uint8Array(await readFile(path.join(runsDir, file))), contentType(file));
      }
      console.log(`  ${runFiles.filter((f) => f.endsWith('run.json')).length} saved runs copied`);
    }
  }
  const demo = args('demo')[0];
  if (demo) console.log(`AYNA_DEMO_SCAN=${owner.id}/${demo}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
