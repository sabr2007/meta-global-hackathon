// The receipt: after the robots are done, where is every object compared with the imagined photo?
//
// Success threshold: an object matches when it rests within 3 cm of its goal (and, for objects with a
// clear long axis, within 15° of the goal heading). 3 cm is about half the smallest object on our
// desks (a 5.5 cm earbud case), so a miss is visible in the photo; it is 5x stricter than the 15 cm
// Meta's Habitat "tidy house" benchmark uses at room scale.
//
// Score: the share of requested moves done, times the share of the other objects left in place, so
// a refused or failed move always costs points, including a move Spark declined before the edit
// was drawn because no robot could do it. Positions are checked against the goals the robots
// were sent to; the independent check is the overlap of the twin, rendered from the photo's camera,
// with the imagined photo's masks (relative to the same overlap on the real photo before anything
// moved, since a scanned mesh never covers its photo mask exactly).

import type { PhotoCamera, Vec3 } from './camera';
import { placeOnPlane, type ObjectGoal } from './goals';
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
  overlap: number | null; // iou / baselineIou, capped at 1: 1 = as good as the scan itself
  photoErrorM: number | null; // centre of the rendered twin vs centre of the imagined photo's mask, both on the table
  ok: boolean;
  note: string; // refusal or failure reason, if any
}

export interface Receipt {
  score: number; // 0-100: moves done / asked × objects left in place / objects that should stay
  matched: number; // objects that match the imagined photo
  total: number;
  medianErrorCm: number; // over the requested moves (all objects when nothing had to move)
  moved: { done: number; asked: number };
  stayed: { kept: number; total: number };
  overlap: number | null; // mean contour overlap of the moved objects (independent of the goals)
  photoMedianErrorCm: number | null; // the same comparison in centimetres: rendered twin vs imagined photo, moved objects
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
  refusedBefore?: Map<string, string>; // moves the request implied that Spark kept out of the edit (no robot could do them)
}

export function measure(input: MeasureInput): Receipt {
  const results: ObjectResult[] = input.goals.map((goal) => {
    const start = input.start.get(goal.name)!;
    const final = input.final.get(goal.name)!;
    const early = goal.moves ? undefined : input.refusedBefore?.get(goal.name);
    const wanted = goal.moves || early !== undefined ? 'move' : 'stay';
    const target = goal.moves ? goal.to : start.position;
    const errorM = Math.hypot(final.position[0] - target[0], final.position[1] - target[1]);
    const turned = yawOf(final.rotation) - yawOf(start.rotation);
    const headingErrorRad = goal.yawDelta ? headingError(turned, goal.yawDelta) : null;
    const mesh = input.meshes.get(goal.name);
    let overlap: number | null = null;
    let baseline: number | null = null;
    let photoErrorM: number | null = null;
    if (mesh && goal.mask) {
      const rendered = silhouette(input.camera, mesh, final);
      overlap = iou(rendered, goal.mask);
      const before = input.beforeMasks.get(goal.name);
      if (before) baseline = iou(silhouette(input.camera, mesh, start), before);
      // Independent of how the goal was read off the mask: both centres go through the same projection.
      const height = final.position[2];
      const twin = placeOnPlane(input.camera, rendered, height).center;
      const imagined = placeOnPlane(input.camera, goal.mask, height).center;
      if (twin && imagined) photoErrorM = Math.hypot(twin[0] - imagined[0], twin[1] - imagined[1]);
    }
    const ok = early === undefined && goal.found && errorM <= PLACE_TOLERANCE_M && (headingErrorRad === null || headingErrorRad <= HEADING_TOLERANCE);
    const relative = overlap !== null && baseline ? Math.min(1, overlap / baseline) : null;
    return {
      name: goal.name,
      label: goal.label,
      wanted,
      final: final.position,
      errorM,
      headingErrorDeg: headingErrorRad === null ? null : (headingErrorRad * 180) / Math.PI,
      iou: overlap,
      baselineIou: baseline,
      overlap: relative,
      photoErrorM,
      ok,
      note: input.notes.get(goal.name) ?? (early !== undefined ? `refused before the edit: ${early}` : ''),
    };
  });
  // The headline error is over the requested moves that got a goal; objects that only had to stay
  // would flatter it, and a move refused before the edit has no goal to be off from.
  const moving = results.filter((r) => r.wanted === 'move' && !input.refusedBefore?.has(r.name));
  const errors = (moving.length ? moving : results).map((r) => r.errorM * 100).sort((a, b) => a - b);
  const mid = errors.length >> 1;
  const medianErrorCm = errors.length ? (errors.length % 2 ? errors[mid] : (errors[mid - 1] + errors[mid]) / 2) : 0;
  const matched = results.filter((r) => r.ok).length;
  const asked = results.filter((r) => r.wanted === 'move');
  const stays = results.filter((r) => r.wanted === 'stay');
  const done = asked.filter((r) => r.ok).length;
  const kept = stays.filter((r) => r.ok).length;
  const share = (n: number, d: number): number => (d ? n / d : 1);
  const overlaps = asked.map((r) => r.overlap).filter((v): v is number => v !== null);
  const photo = asked.map((r) => r.photoErrorM).filter((v): v is number => v !== null).map((v) => v * 100).sort((a, b) => a - b);
  const half = photo.length >> 1;
  return {
    score: results.length ? Math.round(100 * share(done, asked.length) * share(kept, stays.length)) : 0,
    matched,
    total: results.length,
    medianErrorCm,
    moved: { done, asked: asked.length },
    stayed: { kept, total: stays.length },
    overlap: overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : null,
    photoMedianErrorCm: photo.length ? (photo.length % 2 ? photo[half] : (photo[half - 1] + photo[half]) / 2) : null,
    results,
  };
}
