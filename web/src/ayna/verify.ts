// The receipt: after the robots are done, where is every object compared with the imagined photo?
//
// Success threshold: an object matches when it rests within 3 cm of its goal (and, for objects with a
// clear long axis, within 15° of the goal heading). 3 cm is about half the smallest object on our
// desks (a 5.5 cm earbud case), so a miss is visible in the photo; it is 5x stricter than the 15 cm
// Meta's Habitat "tidy house" benchmark uses at room scale.

import type { PhotoCamera, Vec3 } from './camera';
import type { ObjectGoal } from './goals';
import type { TriangleMesh } from './glb';
import { silhouette } from './raster';
import { iou, type Rle } from './rle';
import type { Physics } from '../sim/physics';

export const PLACE_TOLERANCE_M = 0.03;
export const HEADING_TOLERANCE = (15 * Math.PI) / 180;

export interface ObjectResult {
  name: string;
  label: string;
  wanted: 'move' | 'stay';
  final: Vec3;
  errorM: number;
  headingErrorDeg: number | null;
  iou: number | null; // rendered sim vs the imagined photo's mask
  baselineIou: number | null; // the same comparison on the real photo before anything moved
  ok: boolean;
  note: string; // refusal or failure reason, if any
}

export interface Receipt {
  score: number; // 0-100: share of objects that match the imagined photo
  matched: number;
  total: number;
  medianErrorCm: number;
  moved: { done: number; asked: number };
  results: ObjectResult[];
}

export interface BodyPose {
  position: Vec3;
  rotation: Float64Array | number[];
}

export function bodyPose(physics: Physics, name: string): BodyPose {
  const { mujoco, model, data } = physics;
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
  return {
    position: [data.xpos[body * 3], data.xpos[body * 3 + 1], data.xpos[body * 3 + 2]],
    rotation: Array.from(data.xmat.subarray(body * 9, body * 9 + 9)),
  };
}

const yawOf = (rotation: ArrayLike<number>): number => Math.atan2(rotation[3], rotation[0]);

function headingError(turned: number, wanted: number): number {
  let d = turned - wanted;
  while (d > Math.PI / 2) d -= Math.PI;
  while (d <= -Math.PI / 2) d += Math.PI;
  return Math.abs(d);
}

export interface MeasureInput {
  camera: PhotoCamera;
  goals: ObjectGoal[];
  start: Map<string, BodyPose>; // poses when the run began
  final: Map<string, BodyPose>;
  meshes: Map<string, TriangleMesh>;
  beforeMasks: Map<string, Rle>;
  notes: Map<string, string>; // refusals and failed steps
}

export function measure(input: MeasureInput): Receipt {
  const results: ObjectResult[] = input.goals.map((goal) => {
    const start = input.start.get(goal.name)!;
    const final = input.final.get(goal.name)!;
    const wanted = goal.moves ? 'move' : 'stay';
    const target = goal.moves ? goal.to : start.position;
    const errorM = Math.hypot(final.position[0] - target[0], final.position[1] - target[1]);
    const turned = yawOf(final.rotation) - yawOf(start.rotation);
    const headingErrorRad = goal.yawDelta ? headingError(turned, goal.yawDelta) : null;
    const mesh = input.meshes.get(goal.name);
    let overlap: number | null = null;
    let baseline: number | null = null;
    if (mesh && goal.mask) {
      overlap = iou(silhouette(input.camera, mesh, final), goal.mask);
      const before = input.beforeMasks.get(goal.name);
      if (before) baseline = iou(silhouette(input.camera, mesh, start), before);
    }
    const ok = goal.found && errorM <= PLACE_TOLERANCE_M && (headingErrorRad === null || headingErrorRad <= HEADING_TOLERANCE);
    return {
      name: goal.name,
      label: goal.label,
      wanted,
      final: final.position,
      errorM,
      headingErrorDeg: headingErrorRad === null ? null : (headingErrorRad * 180) / Math.PI,
      iou: overlap,
      baselineIou: baseline,
      ok,
      note: input.notes.get(goal.name) ?? '',
    };
  });
  const errors = results.map((r) => r.errorM * 100).sort((a, b) => a - b);
  const mid = errors.length >> 1;
  const medianErrorCm = errors.length ? (errors.length % 2 ? errors[mid] : (errors[mid - 1] + errors[mid]) / 2) : 0;
  const matched = results.filter((r) => r.ok).length;
  const asked = results.filter((r) => r.wanted === 'move');
  return {
    score: results.length ? Math.round((100 * matched) / results.length) : 0,
    matched,
    total: results.length,
    medianErrorCm,
    moved: { done: asked.filter((r) => r.ok).length, asked: asked.length },
    results,
  };
}
