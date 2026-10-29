// One entry point for every /api route: the Vercel function and the Vite dev server both call `handle`.

import * as ayna from './ayna.js';
import { MetaError } from './meta.js';
import { accountRoutes } from './routes/account.js';
import { scanRoutes, serveDevFile } from './routes/scans.js';
import { liveGate, HttpError, json, readJson, type Route } from './http.js';

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** Live model calls: only for signed-in users, within their daily allowance. */
const modelRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/ayna/listen',
    run: async (request) => {
      await liveGate(request, 'listen');
      const audio = new Uint8Array(await request.arrayBuffer());
      if (audio.length < 44 || audio.length > MAX_AUDIO_BYTES) throw new HttpError(400, 'Send a WAV clip under 4 MB');
      return json(await ayna.listen(audio));
    },
  },
  {
    method: 'POST',
    path: '/api/ayna/instruct',
    run: async (request) => {
      await liveGate(request, 'run');
      return json(await ayna.instruct(await readJson<ayna.InstructInput>(request, ['request', 'photo', 'objects', 'robots'])));
    },
  },
  {
    method: 'POST',
    path: '/api/ayna/imagine',
    run: async (request) => {
      await liveGate(request, 'imagine');
      return json(await ayna.imagine(await readJson<{ photo: string; prompt: string }>(request, ['photo', 'prompt'])));
    },
  },
  {
    method: 'POST',
    path: '/api/ayna/segment',
    run: async (request) => {
      await liveGate(request, 'step');
      return json(await ayna.segment(await readJson<ayna.SegmentInput>(request, ['image', 'width', 'height', 'objects'])));
    },
  },
  {
    method: 'POST',
    path: '/api/ayna/judge',
    run: async (request) => {
      await liveGate(request, 'step');
      return json(await ayna.judge(await readJson<ayna.JudgeInput>(request, ['request', 'prompt', 'before', 'candidates'])));
    },
  },
  {
    method: 'POST',
    path: '/api/ayna/plan',
    run: async (request) => {
      await liveGate(request, 'step');
      return json(await ayna.plan(await readJson<ayna.PlanInput>(request, ['request', 'moves', 'robots', 'facts'])));
    },
  },
  {
    method: 'POST',
    path: '/api/ayna/verdict',
    run: async (request) => {
      await liveGate(request, 'step');
      return json(await ayna.verdict(await readJson<ayna.VerdictInput>(request, ['request', 'after', 'render', 'results', 'score'])));
    },
  },
];

const routes: Route[] = [...modelRoutes, ...accountRoutes, ...scanRoutes];

function match(route: Route, method: string, path: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const want = route.path.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(have[i]);
    else if (want[i] !== have[i]) return null;
  }
  return params;
}

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // On Vercel every /api path is rewritten to one function; the original path rides along.
  const path = url.searchParams.get('__path') ? `/api/${url.searchParams.get('__path')}` : url.pathname;
  try {
    if (path.startsWith('/api/files/')) return await serveDevFile(request, path.slice('/api/files/'.length));
    for (const route of routes) {
      const params = match(route, request.method, path);
      if (params) return await route.run(request, params);
    }
    throw new HttpError(404, `No route for ${request.method} ${path}`);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status, error.headers);
    if (error instanceof MetaError) return json({ error: error.message }, error.status);
    console.error(error);
    return json({ error: 'Internal error' }, 500);
  }
}
