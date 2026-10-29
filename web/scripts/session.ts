// Sign the scripts in to an Ayna server as the account whose history they read and write: AYNA_EMAIL
// and AYNA_PASSWORD, from the environment or web/.env.local (the owner you created with seed.ts).
// AYNA_URL picks the server (default: the local dev server).

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Session } from '../src/ayna/client';

const ROOT = path.resolve(import.meta.dirname, '..');
for (const file of [path.join(ROOT, '.env.local'), path.join(ROOT, '..', '.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export const BASE = process.env.AYNA_URL ?? 'http://localhost:5190';

export async function login(): Promise<{ session: Session; owner: string }> {
  const email = process.env.AYNA_EMAIL;
  const password = process.env.AYNA_PASSWORD;
  if (!email || !password) throw new Error('set AYNA_EMAIL and AYNA_PASSWORD (the account runs are saved to), e.g. in web/.env.local');
  const response = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!response.ok) throw new Error(`login to ${BASE} failed: ${response.status}`);
  const { user } = (await response.json()) as { user: { id: string } };
  return { session: { base: BASE, headers: { cookie: response.headers.get('set-cookie')!.split(';')[0] } }, owner: user.id };
}
