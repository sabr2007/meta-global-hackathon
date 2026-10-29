// Scans ("mirrors"), their saved Ayna runs, iPhone uploads, and file access.
// Layout in the private store:
//   scans/<owner>/<scan>/meta.json                scan card: name, status, counts
//   scans/<owner>/<scan>/bundle/<file>            scene bundle from scan2sim
//   scans/<owner>/<scan>/runs/<run>/run.json      one Ayna run (plan, numbers, timings)
//   scans/<owner>/<scan>/runs/<run>/<image>       its pictures
//   uploads/<owner>/<scan>.zip                    capture sent from the iPhone, waiting for the worker

import { randomBytes } from 'node:crypto';
import type { User } from '../auth';
import { currentUser } from '../auth';
import { HttpError, json, readJson, requireUser, type Route } from '../http';
import { checkFileSignature, getJson, putJson, store } from '../store';

const MAX_RUN_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RUN_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,80}\.(webp|jpg|jpeg|png)$/;
const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  glb: 'model/gltf-binary',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  zip: 'application/zip',
};

export interface ScanMeta {
  id: string;
  owner: string;
  name: string;
  created: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string;
  objects: number;
  robots: number;
  members?: string[]; // other user ids who may open the scan and run Ayna on it
  runs?: number;
}

export function contentType(key: string): string {
  return CONTENT_TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** The guest demo: one scan anyone may open (replays only). */
function demoScan(): { owner: string; id: string } | null {
  const [owner, id] = (process.env.AYNA_DEMO_SCAN ?? '').split('/');
  return owner && id ? { owner, id } : null;
}

function checkIds(owner: string, scan: string): void {
  if (!/^[a-f0-9]{12}$/.test(owner) || !ID_PATTERN.test(scan)) throw new HttpError(400, 'Bad scan id');
}

async function scanMeta(owner: string, scan: string): Promise<ScanMeta | null> {
  return getJson<ScanMeta>(store(), `scans/${owner}/${scan}/meta.json`);
}

function isMember(user: User | null, meta: ScanMeta | null): boolean {
  return !!user && !!meta && (meta.owner === user.id || (meta.members ?? []).includes(user.id));
}

async function canRead(user: User | null, owner: string, scan: string): Promise<boolean> {
  const demo = demoScan();
  if (demo !== null && demo.owner === owner && demo.id === scan) return true;
  return isMember(user, await scanMeta(owner, scan));
}

async function requireMember(request: Request, owner: string, scan: string): Promise<User> {
  const user = await requireUser(request);
  if (!isMember(user, await scanMeta(owner, scan))) throw new HttpError(403, 'Only people the scan is shared with can save runs');
  return user;
}

async function runCount(owner: string, scan: string): Promise<number> {
  const keys = await store().list(`scans/${owner}/${scan}/runs/`);
  return keys.filter((k) => k.endsWith('/run.json')).length;
}

export const scanRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/scans',
    run: async (request) => {
      const user = await currentUser(request);
      const demo = demoScan();
      const metas: ScanMeta[] = [];
      if (user) {
        const keys = await store().list('scans/');
        for (const key of keys.filter((k) => /^scans\/[^/]+\/[^/]+\/meta\.json$/.test(k))) {
          const meta = await getJson<ScanMeta>(store(), key);
          if (isMember(user, meta)) metas.push({ ...meta!, runs: await runCount(meta!.owner, meta!.id) });
        }
      } else if (demo) {
        const meta = await scanMeta(demo.owner, demo.id);
        if (meta) metas.push({ ...meta, runs: await runCount(demo.owner, demo.id) });
      }
      metas.sort((a, b) => b.created.localeCompare(a.created));
      return json({ user, demo, scans: metas });
    },
  },
  {
    method: 'GET',
    path: '/api/scans/:owner/:scan',
    run: async (request, { owner, scan }) => {
      checkIds(owner, scan);
      const user = await currentUser(request);
      if (!(await canRead(user, owner, scan))) throw new HttpError(user ? 403 : 401, 'Sign in to open this scan');
      const meta = await scanMeta(owner, scan);
      if (!meta) throw new HttpError(404, 'Scan not found');
      const prefix = `scans/${owner}/${scan}/bundle/`;
      const keys = await store().list(prefix);
      const files: Record<string, string> = {};
      await Promise.all(keys.map(async (key) => (files[key.slice(prefix.length)] = await store().readUrl(key))));
      return json({ meta, files, live: isMember(user, meta) });
    },
  },
  {
    method: 'GET',
    path: '/api/scans/:owner/:scan/runs',
    run: async (request, { owner, scan }) => {
      checkIds(owner, scan);
      if (!(await canRead(await currentUser(request), owner, scan))) throw new HttpError(401, 'Sign in to see these runs');
      const keys = (await store().list(`scans/${owner}/${scan}/runs/`)).filter((k) => k.endsWith('/run.json'));
      const runs = await Promise.all(
        keys.map(async (key) => {
          const run = await getJson<Record<string, unknown>>(store(), key);
          if (!run) return null;
          const { id, created, request: text, score, costUsd, durationMs, status, thumb } = run;
          const thumbUrl = typeof thumb === 'string' ? await store().readUrl(key.replace(/run\.json$/, thumb)) : null;
          return { id, created, request: text, score, costUsd, durationMs, status, thumb: thumbUrl };
        }),
      );
      return json({ runs: runs.filter(Boolean).sort((a, b) => String(b!.created).localeCompare(String(a!.created))) });
    },
  },
  {
    method: 'GET',
    path: '/api/scans/:owner/:scan/runs/:run',
    run: async (request, { owner, scan, run }) => {
      checkIds(owner, scan);
      if (!ID_PATTERN.test(run)) throw new HttpError(400, 'Bad run id');
      if (!(await canRead(await currentUser(request), owner, scan))) throw new HttpError(401, 'Sign in to see this run');
      const prefix = `scans/${owner}/${scan}/runs/${run}/`;
      const record = await getJson<Record<string, unknown>>(store(), `${prefix}run.json`);
      if (!record) throw new HttpError(404, 'Run not found');
      const files: Record<string, string> = {};
      for (const key of await store().list(prefix)) {
        if (!key.endsWith('run.json')) files[key.slice(prefix.length)] = await store().readUrl(key);
      }
      return json({ run: record, files });
    },
  },
  {
    method: 'PUT',
    path: '/api/scans/:owner/:scan/runs/:run/files/:name',
    run: async (request, { owner, scan, run, name }) => {
      checkIds(owner, scan);
      await requireMember(request, owner, scan);
      if (!ID_PATTERN.test(run) || !FILE_PATTERN.test(name)) throw new HttpError(400, 'Bad run file name');
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_RUN_FILE_BYTES) throw new HttpError(413, 'Run pictures must be under 4 MB');
      await store().putBytes(`scans/${owner}/${scan}/runs/${run}/${name}`, bytes, contentType(name));
      return json({ ok: true });
    },
  },
  {
    method: 'PUT',
    path: '/api/scans/:owner/:scan/runs/:run',
    run: async (request, { owner, scan, run }) => {
      checkIds(owner, scan);
      const user = await requireMember(request, owner, scan);
      if (!ID_PATTERN.test(run)) throw new HttpError(400, 'Bad run id');
      const text = await request.text();
      if (text.length > MAX_RUN_JSON_BYTES) throw new HttpError(413, 'Run record too large');
      const record = JSON.parse(text) as Record<string, unknown>;
      await putJson(store(), `scans/${owner}/${scan}/runs/${run}/run.json`, { ...record, id: run, scan: `${owner}/${scan}`, by: user.id });
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/uploads',
    run: async (request) => {
      const user = await requireUser(request);
      const { name, sizeBytes, capturedAt } = await readJson<{ name: string; sizeBytes: number; capturedAt?: string }>(request, ['name', 'sizeBytes']);
      if (!(sizeBytes > 0 && sizeBytes <= MAX_UPLOAD_BYTES)) throw new HttpError(413, 'Scans must be under 500 MB');
      const scanId = `scan-${randomBytes(4).toString('hex')}`;
      const meta: ScanMeta = {
        id: scanId,
        owner: user.id,
        name: String(name).slice(0, 60) || 'Mirror',
        created: capturedAt && !Number.isNaN(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : new Date().toISOString(),
        status: 'queued',
        objects: 0,
        robots: 0,
      };
      await putJson(store(), `scans/${user.id}/${scanId}/meta.json`, { ...meta, status: 'failed', error: 'Upload not finished' });
      const target = await store().uploadTarget(`uploads/${user.id}/${scanId}.zip`, 'application/zip', MAX_UPLOAD_BYTES);
      return json({ scanId, uploadUrl: target.url, method: target.method, headers: target.headers });
    },
  },
  {
    method: 'POST',
    path: '/api/uploads/:scan/complete',
    run: async (request, { scan }) => {
      const user = await requireUser(request);
      checkIds(user.id, scan);
      const meta = await scanMeta(user.id, scan);
      if (!meta) throw new HttpError(404, 'Unknown upload');
      if (!(await store().getBytes(`uploads/${user.id}/${scan}.zip`))) throw new HttpError(409, 'The .zip has not arrived yet');
      await putJson(store(), `scans/${user.id}/${scan}/meta.json`, { ...meta, status: 'queued', error: undefined });
      await putJson(store(), `queue/${user.id}--${scan}.json`, { owner: user.id, scan, queued: new Date().toISOString() });
      return json({ status: 'queued' });
    },
  },
];

/** Signed file access for the disk store (local development); not reachable on Vercel. */
export async function serveDevFile(request: Request, key: string): Promise<Response> {
  const url = new URL(request.url);
  if (store().kind !== 'disk' || !checkFileSignature(key, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '')) {
    return new Response('Forbidden', { status: 403 });
  }
  if (request.method === 'PUT') {
    await store().putBytes(key, new Uint8Array(await request.arrayBuffer()), contentType(key));
    return new Response(null, { status: 200 });
  }
  const bytes = await store().getBytes(key);
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(bytes as BlobPart, { headers: { 'content-type': contentType(key), 'cache-control': 'private, max-age=3600' } });
}
