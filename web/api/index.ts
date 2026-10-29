// The one Vercel Function: every /api/* path is rewritten here (vercel.json) and routed in server/router.ts.

import { handle } from '../server/router.js';

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
