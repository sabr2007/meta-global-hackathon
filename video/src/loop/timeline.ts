import { Easing, interpolate } from 'remotion';
import { candidates } from '../data';

// AynaLoop at 30 fps: one real run, start to receipt, then back to the first frame so it loops.
export const FPS = 30;

export const BEATS = {
  request: { from: 0, frames: 96 },
  segment: { from: 96, frames: 120 },
  instruct: { from: 216, frames: 120 },
  develop: { from: 336, frames: 240 },
  wipe: { from: 576, frames: 210 },
  plan: { from: 786, frames: 120 },
  twin: { from: 906, frames: 180 },
  receipt: { from: 1086, frames: 180 },
  outro: { from: 1266, frames: 54 },
} as const;

export type BeatName = keyof typeof BEATS;
export const LOOP_FRAMES = BEATS.outro.from + BEATS.outro.frames;

/** 0..1 over [start, end] frames with an ease, clamped. */
export function ramp(frame: number, start: number, end: number, ease: (t: number) => number = Easing.bezier(0.16, 1, 0.3, 1)): number {
  return interpolate(frame, [start, end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
}

/** Fade in over `fade` frames at the start and out over `fade` frames at the end of a beat. */
export function beatOpacity(local: number, frames: number, fade = 10): number {
  return Math.min(ramp(local, 0, fade, Easing.linear), 1 - ramp(local, frames - fade, frames, Easing.linear));
}

export const W = 1080;
export const H = 1350;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where each version sits on the contact sheet: one row of up to 3, or two rows (rounds). */
export function contactLayout(count = candidates.length): Rect[] {
  const shown = Math.min(count, 6);
  const rows = shown > 3 ? 2 : 1;
  const cols = Math.min(shown, 3);
  const width = rows === 1 ? 308 : 236;
  const height = (width * 4) / 3;
  const gapX = rows === 1 ? 30 : 40;
  const gapY = 150; // room for the stamp under each version
  const total = cols * width + (cols - 1) * gapX;
  const left0 = (W - total) / 2;
  const top0 = rows === 1 ? 372 : 236;
  return Array.from({ length: shown }, (_, i) => ({
    left: left0 + (i % 3) * (width + gapX),
    top: top0 + Math.floor(i / 3) * (height + gapY),
    width,
    height,
  }));
}

/** The versions on the sheet: at most 6, keeping the chosen one and the latest round. */
export function sheetCandidates() {
  return candidates.slice(-6);
}
