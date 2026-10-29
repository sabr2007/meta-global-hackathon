// Calls to Ayna's own server (the browser and the Node eval use the same client).

import type { Models, Usage } from './run';
import type { Rle } from './rle';
import type { RunRecord } from './record';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Session {
  base: string; // '' in the browser, http://localhost:5190 in Node
  headers?: Record<string, string>; // e.g. a cookie in Node
}

async function request<T>(session: Session, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${session.base}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...session.headers, ...init.headers },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!response.ok) throw new ApiError((body as { error?: string })?.error ?? `HTTP ${response.status}`, response.status);
  return body as T;
}

const post = <T>(session: Session, path: string, body: unknown): Promise<T> => request<T>(session, path, { method: 'POST', body: JSON.stringify(body) });

/** Speech-to-text cleanup: a word heard twice in a row ("my my desk") is kept once, and trailing
 * dots become one full stop. */
export function tidyTranscript(text: string): string {
  return text
    .replace(/(?<![\p{L}\p{N}])([\p{L}\p{N}']+)(?:\s+\1)+(?![\p{L}\p{N}])/giu, '$1')
    .replace(/\s*\.{2,}\s*$/, '.')
    .trim();
}

export function models(session: Session): Models & { listen(wav: Blob | Uint8Array): Promise<{ text: string; usage: Usage[] }> } {
  return {
    instruct: (input) => post(session, '/api/ayna/instruct', input),
    imagine: (input) => post(session, '/api/ayna/imagine', input),
    segment: (input) => post(session, '/api/ayna/segment', input),
    judge: (input) => post(session, '/api/ayna/judge', input),
    decide: (input) => post(session, '/api/ayna/decide', input),
    plan: (input) => post(session, '/api/ayna/plan', input),
    listen: async (wav) => {
      const heard = await request<{ text: string; usage: Usage[] }>(session, '/api/ayna/listen', { method: 'POST', body: wav as BodyInit, headers: { 'content-type': 'audio/wav' } });
      return { ...heard, text: tidyTranscript(heard.text) };
    },
  };
}

export function verdict(session: Session, input: { request: string; after: string; render?: string; results: string[]; score: number }): Promise<{ verdict: { verdict: string; matches_request: boolean }; usage: Usage[] }> {
  return post(session, '/api/ayna/verdict', input);
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface ScanCard {
  id: string;
  owner: string;
  name: string;
  created: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string;
  objects: number;
  robots: number;
  runs?: number;
}

export interface RunCard {
  id: string;
  created: string;
  request: string;
  score: number | null;
  costUsd: number;
  durationMs: number;
  status: string;
  thumb: string | null;
  rejected: number;
  versions: number;
  moves: { done: number; asked: number } | null;
}

export const account = {
  me: (session: Session) => request<{ user: User | null }>(session, '/api/auth/me'),
  login: (session: Session, email: string, password: string) => post<{ user: User }>(session, '/api/auth/login', { email, password }),
  logout: (session: Session) => post<{ ok: boolean }>(session, '/api/auth/logout', {}),
  pairCode: (session: Session) => post<{ code: string; expires: string }>(session, '/api/devices/pair-code', {}),
};

export const scans = {
  list: (session: Session) => request<{ user: User | null; demo: { owner: string; id: string; run: string | null } | null; scans: ScanCard[] }>(session, '/api/scans'),
  open: (session: Session, owner: string, id: string) => request<{ meta: ScanCard; files: Record<string, string>; live: boolean }>(session, `/api/scans/${owner}/${id}`),
  runs: (session: Session, owner: string, id: string) => request<{ runs: RunCard[] }>(session, `/api/scans/${owner}/${id}/runs`),
  run: (session: Session, owner: string, id: string, run: string) => request<{ run: RunRecord; files: Record<string, string> }>(session, `/api/scans/${owner}/${id}/runs/${run}`),
  async saveRun(session: Session, owner: string, id: string, record: RunRecord, files: Record<string, string>): Promise<void> {
    for (const [name, dataUrl] of Object.entries(files)) {
      const blob = await (await fetch(dataUrl)).blob();
      await request(session, `/api/scans/${owner}/${id}/runs/${record.id}/files/${name}`, { method: 'PUT', body: blob, headers: { 'content-type': blob.type } });
    }
    await request(session, `/api/scans/${owner}/${id}/runs/${record.id}`, { method: 'PUT', body: JSON.stringify(record), headers: { 'content-type': 'application/json' } });
  },
};

export type { Rle };
