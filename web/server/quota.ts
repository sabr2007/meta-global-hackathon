// Daily allowance for live model calls and saved runs, so live runs open to everyone cannot burn the
// credits: each account by its role, each visitor without one by IP, and all visitors together.

import type { User } from './auth.js';
import { getJson, putJson, store } from './store.js';

export type Allowance = 'run' | 'imagine' | 'listen' | 'step' | 'save' | 'file';

// One Ayna run = 1 'run' (Spark instruction), up to 6 'imagine' (Muse Image) and ~10 'step' calls, then
// 1 'save' (the run record) and up to ~12 'file' (its pictures).
const DAILY: Record<User['role'], Record<Allowance, number>> = {
  owner: { run: 200, imagine: 1200, listen: 400, step: 4000, save: 400, file: 5000 },
  judge: { run: 15, imagine: 90, listen: 60, step: 300, save: 30, file: 400 },
  member: { run: 5, imagine: 30, listen: 20, step: 100, save: 10, file: 120 },
  guest: { run: 5, imagine: 30, listen: 20, step: 100, save: 5, file: 60 },
};
// All visitors without an account together: about 30 live runs a day (~$3 of Meta calls).
const VISITORS_DAILY: Record<Allowance, number> = { run: 30, imagine: 180, listen: 120, step: 600, save: 30, file: 360 };

async function count(key: string, kind: Allowance, limit: number): Promise<number> {
  const used = (await getJson<Record<string, number>>(store(), key)) ?? {};
  if ((used[kind] ?? 0) >= limit) return -1;
  used[kind] = (used[kind] ?? 0) + 1;
  await putJson(store(), key, used);
  return limit - used[kind];
}

/** Count one call; returns how many are left today (negative = over the limit, the call is refused). */
export async function spend(user: User, kind: Allowance): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const left = await count(`usage/${user.id}/${day}.json`, kind, DAILY[user.role][kind]);
  if (left < 0 || user.role !== 'guest') return left;
  return Math.min(left, await count(`usage/visitors/${day}.json`, kind, VISITORS_DAILY[kind]));
}
