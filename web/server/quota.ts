// Per-user daily allowance for live model calls, so a shared demo account cannot burn the credits.

import type { User } from './auth.js';
import { getJson, putJson, store } from './store.js';

export type Allowance = 'run' | 'imagine' | 'listen' | 'step';

// One Ayna run = 1 'run' (Spark instruction), up to 6 'imagine' (Muse Image) and ~10 'step' calls.
const DAILY: Record<User['role'], Record<Allowance, number>> = {
  owner: { run: 200, imagine: 1200, listen: 400, step: 4000 },
  judge: { run: 15, imagine: 90, listen: 60, step: 300 },
  member: { run: 5, imagine: 30, listen: 20, step: 100 },
};

/** Count one call; returns how many are left today (negative = over the limit, the call is refused). */
export async function spend(user: User, kind: Allowance): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `usage/${user.id}/${day}.json`;
  const used = (await getJson<Record<string, number>>(store(), key)) ?? {};
  const limit = DAILY[user.role][kind];
  if ((used[kind] ?? 0) >= limit) return -1;
  used[kind] = (used[kind] ?? 0) + 1;
  await putJson(store(), key, used);
  return limit - used[kind];
}
