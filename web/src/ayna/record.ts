// A saved Ayna run: everything needed to show it again and to replay the robots for free.

import type { Vec3 } from './camera';
import type { PlannedStep, Refusal } from './dispatch';
import type { Rle } from './rle';
import type { Instruction, Judgement, TraceEvent, Usage } from './run';
import type { Receipt } from './verify';

export interface RunRecord {
  version: 1;
  id: string;
  created: string;
  request: string;
  source: 'text' | 'voice' | 'eval';
  transcript?: string;
  status: 'done' | 'no-after' | 'failed';
  error?: string;
  instruction: Instruction | null;
  feedback: string[];
  candidates: {
    id: string;
    round: number;
    file: string;
    width: number;
    height: number;
    passed: boolean;
    reasons: string[];
    notes: string[];
  }[];
  chosen: string | null;
  judgement: Judgement | null;
  goals: { name: string; label: string; found: boolean; moves: boolean; from: Vec3; to: Vec3; yawDelta: number; distanceM: number; mask: Rle | null }[];
  steps: PlannedStep[];
  refusals: Refusal[];
  fixes: string[];
  orderReason: string;
  executed: { object: string; robot: string; ok: boolean; reason: string }[];
  receipt: Receipt | null;
  verdict: { verdict: string; matches_request: boolean } | null;
  trace: (Pick<TraceEvent, 'step' | 'state' | 'text' | 'candidate'> & { usage?: Usage[]; at: number })[];
  costUsd: number;
  durationMs: number;
  score: number | null;
  thumb: string | null;
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).toLowerCase();
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
