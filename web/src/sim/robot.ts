import type { RobotInfo } from '../scene/bundle';

// The API every robot kind implements (stationary arm, mobile manipulator), so the app drives them
// the same way: commands return at once (accepted, or refused with a reason), progress arrives as
// status updates, and run() wraps a command in a Promise that settles when the robot is done.

export type RobotKind = 'arm' | 'mobile';
export type RobotPhase = 'idle' | 'busy' | 'holding';

export interface RobotStatus {
  phase: RobotPhase;
  text: string;
  holding: string | null;
  error: boolean;
}

/** Whether a robot can pick an object from where it stands (instant; for a live reach map). */
export interface ReachCheck {
  ok: boolean;
  reason: string;
  distance_m: number;
}

export interface StepResult {
  ok: boolean;
  reason: string;
}

export interface BasePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** A step for run(): pick `object` and put it down at (x, y) turned by yawDelta, or one action. */
export type RobotStep =
  | { object: string; x: number; y: number; yawDelta?: number }
  | { action: 'pick'; object: string }
  | { action: 'placeAt'; x: number; y: number; yawDelta?: number }
  | { action: 'placeOn'; object: string }
  | { action: 'putBack' }
  | { action: 'home' };

export interface Robot {
  readonly id: string;
  readonly kind: RobotKind;
  readonly label: string;
  readonly info: RobotInfo;
  readonly status: RobotStatus;
  /** Call before every physics step. */
  update(): void;
  /** Call after the simulation was reset (physics.reset()); keeps where the robot was dragged. */
  reset(): void;
  reachOf(objectName: string): ReachCheck;
  /** Whether the robot can put something down at (x, y) (instant; used to check a plan). */
  reachPoint(x: number, y: number): ReachCheck;
  pick(objectName: string): StepResult;
  /** Put the held object down with its grip point over (x, y), on the surface there, turned by yawDelta (rad). */
  placeAt(x: number, y: number, yawDelta?: number): StepResult;
  /** Put the held object on top of another one. */
  placeOn(objectName: string): StepResult;
  putBack(): StepResult;
  goHome(): StepResult;
  run(step: RobotStep): Promise<StepResult>;
  /** Move the robot instantly (dragging): the arm onto a table top, the mobile base onto free floor. */
  setBasePose(x: number, y: number, yaw: number): StepResult;
  basePose(): BasePose;
  subscribe(listener: (status: RobotStatus) => void): () => void;
  dispose(): void;
}

export const ok = (reason: string): StepResult => ({ ok: true, reason });
export const refused = (reason: string): StepResult => ({ ok: false, reason });

/** Status fan-out and run() for robot implementations. */
export abstract class RobotBase implements Robot {
  abstract readonly kind: RobotKind;
  abstract readonly status: RobotStatus;
  private readonly listeners = new Set<(status: RobotStatus) => void>();
  private waiters: ((result: StepResult) => void)[] = [];

  protected constructor(
    readonly info: RobotInfo,
    protected readonly labels: ReadonlyMap<string, string>,
  ) {}

  get id(): string {
    return this.info.id;
  }

  get label(): string {
    return this.info.label;
  }

  abstract update(): void;
  abstract reset(): void;
  abstract reachOf(objectName: string): ReachCheck;
  abstract reachPoint(x: number, y: number): ReachCheck;
  abstract pick(objectName: string): StepResult;
  abstract placeAt(x: number, y: number, yawDelta?: number): StepResult;
  abstract placeOn(objectName: string): StepResult;
  abstract putBack(): StepResult;
  abstract goHome(): StepResult;
  abstract setBasePose(x: number, y: number, yaw: number): StepResult;
  abstract basePose(): BasePose;
  abstract dispose(): void;

  subscribe(listener: (status: RobotStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  run(step: RobotStep): Promise<StepResult> {
    if (!('action' in step)) return this.pickAndPlace(step.object, step.x, step.y, step.yawDelta ?? 0);
    switch (step.action) {
      case 'pick':
        return this.whenDone(() => this.pick(step.object));
      case 'placeAt':
        return this.whenDone(() => this.placeAt(step.x, step.y, step.yawDelta ?? 0));
      case 'placeOn':
        return this.whenDone(() => this.placeOn(step.object));
      case 'putBack':
        return this.whenDone(() => this.putBack());
      case 'home':
        return this.whenDone(() => this.goHome());
    }
  }

  private async pickAndPlace(object: string, x: number, y: number, yawDelta: number): Promise<StepResult> {
    const holding = this.status.holding;
    if (holding && holding !== object) return refused(`Holding ${this.name(holding)}: put it down first`);
    if (!holding) {
      const picked = await this.whenDone(() => this.pick(object));
      if (!picked.ok) return picked;
    }
    return this.whenDone(() => this.placeAt(x, y, yawDelta));
  }

  /** Start a command; settle when the robot stops being busy (at once if it refused). */
  protected whenDone(start: () => StepResult): Promise<StepResult> {
    const accepted = start();
    if (!accepted.ok) return Promise.resolve(accepted);
    if (this.status.phase !== 'busy') return Promise.resolve({ ok: !this.status.error, reason: this.status.text });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Report a status: listeners hear it, and pending run() calls settle when the robot is done. */
  protected emit(status: RobotStatus): void {
    for (const listener of this.listeners) listener(status);
    if (status.phase !== 'busy' && this.waiters.length > 0) {
      const done = this.waiters;
      this.waiters = [];
      for (const resolve of done) resolve({ ok: !status.error, reason: status.text });
    }
  }

  /** Settle pending run() calls as failed (reset, dispose). */
  protected abandon(reason: string): void {
    const done = this.waiters;
    this.waiters = [];
    for (const resolve of done) resolve(refused(reason));
  }

  protected name(objectName: string): string {
    return this.labels.get(objectName) ?? objectName;
  }

  protected busyReason(): StepResult | null {
    return this.status.phase === 'busy' ? refused(`Busy: ${this.status.text}`) : null;
  }

  /** A refusal when a command gets a coordinate that is not a finite number. */
  protected badNumbers(...values: number[]): StepResult | null {
    return values.every(Number.isFinite) ? null : refused(`Not a valid position: ${values.join(', ')}`);
  }
}
