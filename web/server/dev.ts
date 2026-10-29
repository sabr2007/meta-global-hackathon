// Vite dev-server middleware: /api is served by the same handler as the Vercel function.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') res.setHeader(key, value);
  });
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Server environment (keys) goes to process.env only; nothing here reaches the client bundle. */
export function aynaApi(env: Record<string, string>): Plugin {
  return {
    name: 'ayna-api',
    configureServer(server: ViteDevServer) {
      for (const [key, value] of Object.entries(env)) process.env[key] ??= value;
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          next();
          return;
        }
        void (async () => {
          const { handle } = (await server.ssrLoadModule('/server/router.ts')) as typeof import('./router.js');
          await send(await handle(await toRequest(req)), res);
        })().catch((error: unknown) => {
          console.error(error);
          res.statusCode = 500;
          res.end('dev api error');
        });
      });
    },
  };
}
