// Sign in / out, who am I, and pairing the iPhone scanner with an account.

import { checkPassword, clearedCookie, createPairCode, currentUser, redeemPairCode, sessionCookie } from '../auth';
import { HttpError, json, readJson, requireUser, type Route } from '../http';

const LOGIN_DELAY_MS = 400; // slows down password guessing without a rate-limit store

export const accountRoutes: Route[] = [
  {
    method: 'POST',
    path: '/api/auth/login',
    run: async (request) => {
      const { email, password } = await readJson<{ email: string; password: string }>(request, ['email', 'password']);
      await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
      const user = await checkPassword(String(email), String(password));
      if (!user) throw new HttpError(401, 'Wrong email or password');
      return json({ user }, 200, { 'set-cookie': sessionCookie(user) });
    },
  },
  {
    method: 'POST',
    path: '/api/auth/logout',
    run: async () => json({ ok: true }, 200, { 'set-cookie': clearedCookie() }),
  },
  {
    method: 'GET',
    path: '/api/auth/me',
    run: async (request) => json({ user: await currentUser(request) }),
  },
  {
    method: 'POST',
    path: '/api/devices/pair-code',
    run: async (request) => json(await createPairCode(await requireUser(request))),
  },
  {
    method: 'POST',
    path: '/api/devices/pair',
    run: async (request) => {
      const { code, deviceName } = await readJson<{ code: string; deviceName?: string }>(request, ['code']);
      const paired = await redeemPairCode(String(code), String(deviceName ?? 'iPhone'));
      if (!paired) throw new HttpError(400, 'This code is wrong or expired. Make a new one on the Mirrors page.');
      return json({ token: paired.token, user: { email: paired.user.email } });
    },
  },
];
