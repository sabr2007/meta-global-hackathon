import type { Vec2 } from './navigation';
import type { Physics } from './physics';

// Plays back a robot's plan as position targets: joint-space moves with a minimum-jerk profile,
// and drives where the base follows a path (rounded corners, trapezoidal speed) while the other
// actuators (lift, arm) move in step with the progress along it.

const SAMPLE_M = 0.02; // spacing of the sampled drive curve
const CORNER_CUT_M = 0.3; // corners are rounded starting this far before the waypoint

export const minJerk = (s: number): number => s * s * s * (10 - 15 * s + 6 * s * s);

/** Shortest signed angle from a to b. */
export function angleTo(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

/** Time to travel `length` with a trapezoidal speed profile (triangular when short). */
function trapezoidTime(length: number, speed: number, accel: number): number {
  if (length <= 0) return 0;
  return length >= (speed * speed) / accel ? length / speed + speed / accel : 2 * Math.sqrt(length / accel);
}

/** A base path, sampled densely, travelled in `duration` with a trapezoidal speed profile. */
export class DriveCurve {
  readonly points: [number, number][];
  private readonly cumulative: number[];
  readonly length: number;
  private speed = 0;
  private accel = 0;
  duration = 0;

  constructor(points: readonly Vec2[]) {
    this.points = points.map((p) => [p[0], p[1]]);
    this.cumulative = [0];
    for (let k = 1; k < this.points.length; k += 1) {
      const [ax, ay] = this.points[k - 1];
      const [bx, by] = this.points[k];
      this.cumulative.push(this.cumulative[k - 1] + Math.hypot(bx - ax, by - ay));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  /** Fix the timing: as fast as `speed` and `accel` allow, but not shorter than `minDuration`. */
  timed(speed: number, accel: number, minDuration: number): this {
    const fastest = trapezoidTime(this.length, speed, accel);
    this.duration = Math.max(fastest, minDuration, 1e-3);
    if (this.length <= 0) return this;
    // Slow the trapezoid down until it takes exactly `duration`: L/v + v/a = T.
    const t = this.duration;
    const disc = accel * accel * t * t - 4 * accel * this.length;
    this.accel = accel;
    this.speed = disc >= 0 ? (accel * t - Math.sqrt(disc)) / 2 : Math.sqrt(this.length * accel);
    if (disc < 0) this.accel = (4 * this.length) / (t * t); // triangular profile spanning exactly t
    return this;
  }

  /** Fraction of the length covered after `t` seconds (0..1). */
  progress(t: number): number {
    if (this.length <= 0) return minJerk(Math.min(Math.max(t / this.duration, 0), 1));
    const T = this.duration;
    const time = Math.min(Math.max(t, 0), T);
    const ramp = Math.min(this.speed / this.accel, T / 2);
    const vmax = this.accel * ramp;
    let s: number;
    if (time < ramp) s = 0.5 * this.accel * time * time;
    else if (time > T - ramp) {
      const left = T - time;
      s = this.length - 0.5 * this.accel * left * left;
    } else s = 0.5 * this.accel * ramp * ramp + vmax * (time - ramp);
    return Math.min(Math.max(s / this.length, 0), 1);
  }

  at(fraction: number): [number, number] {
    const s = fraction * this.length;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = this.cumulative[hi] - this.cumulative[lo];
    const k = span > 0 ? (s - this.cumulative[lo]) / span : 0;
    const [ax, ay] = this.points[lo];
    const [bx, by] = this.points[hi];
    return [ax + (bx - ax) * k, ay + (by - ay) * k];
  }
}

function sampleSegment(out: [number, number][], a: Vec2, b: Vec2): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / SAMPLE_M));
  for (let k = 1; k <= steps; k += 1) out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
}

/** Waypoints -> dense curve with corners rounded by quadratic Béziers where `clear` allows. */
export function roundCorners(waypoints: readonly Vec2[], clear: (p: Vec2) => boolean): [number, number][] {
  if (waypoints.length === 0) return [];
  const out: [number, number][] = [[waypoints[0][0], waypoints[0][1]]];
  let from: Vec2 = waypoints[0];
  for (let k = 1; k < waypoints.length - 1; k += 1) {
    const corner = waypoints[k];
    const prev = waypoints[k - 1];
    const next = waypoints[k + 1];
    const inLength = Math.hypot(corner[0] - prev[0], corner[1] - prev[1]);
    const outLength = Math.hypot(next[0] - corner[0], next[1] - corner[1]);
    let cut = Math.min(CORNER_CUT_M, inLength / 2, outLength / 2);
    let arc: [number, number][] | null = null;
    while (cut > 0.02 && !arc) {
      const a: Vec2 = [corner[0] + ((prev[0] - corner[0]) * cut) / inLength, corner[1] + ((prev[1] - corner[1]) * cut) / inLength];
      const b: Vec2 = [corner[0] + ((next[0] - corner[0]) * cut) / outLength, corner[1] + ((next[1] - corner[1]) * cut) / outLength];
      const steps = Math.max(4, Math.ceil((2 * cut) / SAMPLE_M));
      const samples: [number, number][] = [];
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const w0 = (1 - t) * (1 - t);
        const w1 = 2 * (1 - t) * t;
        const w2 = t * t;
        samples.push([w0 * a[0] + w1 * corner[0] + w2 * b[0], w0 * a[1] + w1 * corner[1] + w2 * b[1]]);
      }
      if (samples.every(clear)) {
        sampleSegment(out, from, a);
        arc = samples;
        from = b;
      } else cut /= 2;
    }
    if (arc) out.push(...arc.slice(1));
    else {
      sampleSegment(out, from, corner);
      from = corner;
    }
  }
  sampleSegment(out, from, waypoints[waypoints.length - 1]);
  return out;
}

export interface Move {
  /** Final targets for every actuator of the robot. */
  to: number[];
  duration: number;
  /** Base x and y (target indices 0 and 1) follow this curve; the rest move with its progress. */
  curve?: DriveCurve;
  onStart?: () => void;
  onDone?: () => void;
}

export class MotionQueue {
  private queue: Move[] = [];
  private active: { move: Move; from: number[]; start: number } | null = null;
  /** Targets the actuators were last given (after the active move: its end). */
  target: number[];

  constructor(
    private readonly physics: Physics,
    readonly actuators: readonly number[],
  ) {
    this.target = this.readCtrl();
  }

  get idle(): boolean {
    return !this.active && this.queue.length === 0;
  }

  /** Targets after every queued move. */
  last(): number[] {
    return (this.queue.length > 0 ? this.queue[this.queue.length - 1].to : this.active?.move.to ?? this.target).slice();
  }

  push(move: Move): void {
    this.queue.push(move);
  }

  /** Drop the plan and hold the current targets (or the actuators' present ones). */
  clear(fromCtrl = false): void {
    this.queue = [];
    this.active = null;
    if (fromCtrl) this.target = this.readCtrl();
  }

  /** Stop where the robot is now: the active move's current targets become the hold point. */
  halt(): void {
    this.queue = [];
    if (this.active) this.target = this.readCtrl();
    this.active = null;
  }

  update(): void {
    const time = this.physics.data.time;
    if (!this.active) {
      const next = this.queue.shift();
      if (!next) return;
      this.active = { move: next, from: this.target.slice(), start: time };
      next.onStart?.();
      if (this.active?.move !== next) return; // onStart cancelled the plan
    }
    const { move, from, start } = this.active;
    const elapsed = time - start;
    const s = Math.min(elapsed / move.duration, 1);
    const ctrl = this.physics.data.ctrl;
    if (move.curve) {
      const u = move.curve.progress(elapsed);
      const [x, y] = move.curve.at(u);
      this.actuators.forEach((a, i) => {
        ctrl[a] = i === 0 ? x : i === 1 ? y : from[i] + (move.to[i] - from[i]) * u;
      });
    } else {
      const k = minJerk(s);
      this.actuators.forEach((a, i) => {
        ctrl[a] = from[i] + (move.to[i] - from[i]) * k;
      });
    }
    if (s >= 1) {
      this.target = move.to.slice();
      this.active = null;
      move.onDone?.();
    }
  }

  private readCtrl(): number[] {
    const ctrl = this.physics.data.ctrl;
    return this.actuators.map((a) => ctrl[a]);
  }
}
