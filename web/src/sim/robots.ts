import { robotsOf, type SceneMeta } from '../scene/bundle';
import { MobileManipulator } from './mobileManipulator';
import type { Physics } from './physics';
import type { Robot, RobotStatus } from './robot';
import { SceneGeometry } from './sceneGeometry';
import { StationaryArm } from './stationaryArm';

// Robot registry on the web side: one controller per scene.json `robots[]` entry
// (pipeline/src/scan2sim/robots.py writes them). Every controller implements `Robot` (robot.ts).

export type { BasePose, ReachCheck, Robot, RobotKind, RobotPhase, RobotStatus, RobotStep, StepResult } from './robot';

export interface RobotFleet {
  readonly robots: Robot[];
  readonly scene: SceneGeometry;
  get(id: string): Robot | undefined;
  /** Call before every physics step (pass it as physics.advance's control callback). */
  update(): void;
  /** Call after physics.reset(). */
  reset(): void;
  dispose(): void;
}

export interface FleetOptions {
  /** Object body name -> label (defaults to scene.json objects). */
  labels?: ReadonlyMap<string, string>;
  onStatus?: (robot: Robot, status: RobotStatus) => void;
}

export function createRobots(physics: Physics, meta: SceneMeta, options: FleetOptions = {}): RobotFleet {
  const scene = new SceneGeometry(physics, meta);
  const labels = options.labels ?? new Map((meta.objects ?? []).map((o) => [o.name, o.label]));
  const robots: Robot[] = robotsOf(meta).map((info) =>
    info.kind === 'mobile' ? new MobileManipulator(physics, info, scene, labels) : new StationaryArm(physics, info, scene, labels),
  );
  // Build the navigation grid now, so the first reach check while dragging does not stall.
  for (const info of robotsOf(meta)) if (info.kind === 'mobile') scene.regionsFor(info.footprint_radius + info.nav_margin);
  if (options.onStatus) {
    const listener = options.onStatus;
    for (const robot of robots) robot.subscribe((status) => listener(robot, status));
  }
  return {
    robots,
    scene,
    get: (id) => robots.find((r) => r.id === id),
    update: () => {
      for (const robot of robots) robot.update();
    },
    reset: () => {
      for (const robot of robots) robot.reset();
    },
    dispose: () => {
      for (const robot of robots) robot.dispose();
    },
  };
}
