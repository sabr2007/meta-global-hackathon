// From an imagined "after" photo to metric goals: find every scanned object in it (SAM 3.1 masks),
// check that nothing vanished, appeared or changed size, and turn each mask into a target on the table.

import { hitPlane, pixelRay, project, type PhotoCamera, type Vec3 } from './camera';
import { forEachPixel, iou, maskStats, scaleRle, type Rle } from './rle';

// SAM 3.1 alone varies by about ±8% on the unedited photo (0.92-0.99 on the desk); the image model
// redraws objects on top of that. ±20% (log-symmetric) separates redrawing from a different object.
export const AREA_RATIO_MIN = 0.8;
export const AREA_RATIO_MAX = 1.25;
const STILL_M = 0.015; // closer than this to where it was = not moved
const UNASKED_MOVE_M = 0.06; // an object told to stay that moves further than this fails the check
const ROTATION_MIN = (8 * Math.PI) / 180;
const ELONGATION_MIN = 1.6; // only elongated objects have a meaningful heading
const EXTRA_CONFIDENCE = 0.5;
const DUPLICATE_IOU = 0.5;
const PCA_STEP = 3; // sample every 3rd mask pixel for the heading

export interface SceneObject {
  name: string;
  label: string;
  concept: string;
  size_m: [number, number, number];
  start: Vec3;
}

export interface BeforeMask {
  object: string;
  concept: string;
  area_px: number;
  rle: Rle;
}

export interface SamInstance {
  objectId: string;
  confidence: number | null;
  area: number;
  rle: Rle;
}

export interface Segmented {
  name: string;
  source: 'concept' | 'spark-box' | 'none';
  masks: SamInstance[];
}

export interface ObjectGoal {
  name: string;
  label: string;
  found: boolean;
  source: Segmented['source'];
  mask: Rle | null; // in hero photo pixels
  areaRatio: number; // after/before pixel area, or the same corrected for the new spot (whichever is closer to 1)
  from: Vec3;
  to: Vec3;
  distanceM: number;
  yawDelta: number; // radians, counter-clockwise seen from above
  moves: boolean;
}

export interface CandidateCheck {
  passed: boolean;
  reasons: string[]; // why it is rejected
  notes: string[]; // facts for the judge
  goals: ObjectGoal[];
}

interface Placement {
  center: Vec3 | null;
  heading: number | null; // major axis angle on the table, radians in (-pi/2, pi/2]
}

/** Centre and heading of a mask on the horizontal plane z = height (the object's middle). */
export function placeOnPlane(camera: PhotoCamera, rle: Rle, height: number): Placement {
  const stats = maskStats(rle);
  if (!stats.area) return { center: null, heading: null };
  const center = hitPlane(pixelRay(camera, stats.cx, stats.cy), height);
  const points: [number, number][] = [];
  let i = 0;
  forEachPixel(rle, (x, y) => {
    i += 1;
    if (i % PCA_STEP) return;
    const hit = hitPlane(pixelRay(camera, x + 0.5, y + 0.5), height);
    if (hit) points.push([hit[0], hit[1]]);
  });
  if (points.length < 10) return { center, heading: null };
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const my = points.reduce((s, p) => s + p[1], 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const spread = Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy);
  const major = (sxx + syy + spread) / 2;
  const minor = Math.max((sxx + syy - spread) / 2, 1e-12);
  const heading = major / minor >= ELONGATION_MIN ** 2 ? 0.5 * Math.atan2(2 * sxy, sxx - syy) : null;
  return { center, heading };
}

/** Where an object's mask on the real photo lies on its table plane: a sparse cloud of world xy points. */
export function footprint(camera: PhotoCamera, rle: Rle, height: number, step = 9): [number, number][] {
  const points: [number, number][] = [];
  let i = 0;
  forEachPixel(rle, (x, y) => {
    i += 1;
    if (i % step) return;
    const hit = hitPlane(pixelRay(camera, x + 0.5, y + 0.5), height);
    if (hit) points.push([hit[0], hit[1]]);
  });
  return points;
}

/** Smallest rotation between two headings of a symmetric shape (mod pi). */
export function headingDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI / 2) d -= Math.PI;
  while (d <= -Math.PI / 2) d += Math.PI;
  return d;
}

const distance2d = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Area of the convex hull of 2D points (monotone chain, then the shoelace formula). */
function hullArea(points: [number, number][]): number {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  const hull = [...chain(sorted), ...chain([...sorted].reverse())];
  let twice = 0;
  for (let i = 0; i < hull.length; i += 1) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/**
 * Pixel area of an object's bounding box seen through the photo camera with its centre at `center`:
 * the hull of the eight projected corners. It carries distance, the angle the object is seen at (a
 * flat object at the back of a table looks thinner, not just smaller) and the lens's stretch towards
 * the image edges, so the ratio between two spots is how much a faithfully moved object should change.
 */
export function boxArea(camera: PhotoCamera, size: Vec3, center: Vec3): number {
  const corners: [number, number][] = [];
  for (const dx of [-0.5, 0.5]) {
    for (const dy of [-0.5, 0.5]) {
      for (const dz of [-0.5, 0.5]) {
        const p = project(camera, [center[0] + dx * size[0], center[1] + dy * size[1], center[2] + dz * size[2]]);
        if (p.depth > 0) corners.push([p.x, p.y]);
      }
    }
  }
  return hullArea(corners);
}

export interface CheckInput {
  camera: PhotoCamera;
  objects: SceneObject[];
  before: BeforeMask[];
  segmented: Segmented[]; // SAM on the candidate, in its own pixels
  imageSize: { width: number; height: number }; // the candidate's pixels
  beforeCounts?: Map<string, number>; // confident SAM instances per concept on the real photo
  intent?: Map<string, 'move' | 'stay'>;
}

export function checkCandidate(input: CheckInput): CandidateCheck {
  const { camera, objects } = input;
  const sx = camera.width / input.imageSize.width;
  const sy = camera.height / input.imageSize.height;
  const reasons: string[] = [];
  const notes: string[] = [];

  interface Option {
    object: SceneObject;
    instance: SamInstance;
    rle: Rle;
    ratio: number;
    center: Vec3 | null;
    heading: number | null;
    score: number;
    source: Segmented['source'];
  }
  const beforeOf = new Map(input.before.map((b) => [b.object, b]));
  const options: Option[] = [];
  for (const object of objects) {
    const before = beforeOf.get(object.name);
    const found = input.segmented.find((s) => s.name === object.name);
    if (!before || !found) continue;
    const beforeCenter = placeOnPlane(camera, before.rle, object.start[2]).center;
    const startArea = boxArea(camera, object.size_m, object.start);
    for (const instance of found.masks) {
      const rle = scaleRle(instance.rle, sx, sy);
      const { center, heading } = placeOnPlane(camera, rle, object.start[2]);
      // A moved object may rightly look bigger or smaller: its box, seen from the photo's camera at
      // the new spot, says by how much. Image editors also often move an object at its old pixel
      // size. Either reading is a faithful edit; an object that matches neither was resized (or is
      // something else).
      const goal: Vec3 | null = center && beforeCenter ? [center[0] + object.start[0] - beforeCenter[0], center[1] + object.start[1] - beforeCenter[1], object.start[2]] : null;
      const expected = goal && startArea > 0 ? boxArea(camera, object.size_m, goal) / startArea : 1;
      const raw = maskStats(rle).area / before.area_px;
      const corrected = expected > 0 ? raw / expected : raw;
      const ratio = Math.abs(Math.log(raw)) < Math.abs(Math.log(corrected)) ? raw : corrected;
      const score = Math.abs(Math.log(ratio)) + 0.2 * (1 - (instance.confidence ?? 0.5));
      options.push({ object, instance, rle, ratio, center, heading, score, source: found.source });
    }
  }
  options.sort((a, b) => a.score - b.score);
  const chosen = new Map<string, Option>();
  for (const option of options) {
    if (chosen.has(option.object.name)) continue;
    if ([...chosen.values()].some((c) => iou(c.rle, option.rle) > DUPLICATE_IOU)) continue;
    chosen.set(option.object.name, option);
  }

  const goals: ObjectGoal[] = objects.map((object) => {
    const option = chosen.get(object.name);
    const before = beforeOf.get(object.name);
    if (!option || !before) {
      reasons.push(`${object.label} is missing`);
      return { name: object.name, label: object.label, found: false, source: 'none', mask: null, areaRatio: 0, from: object.start, to: object.start, distanceM: 0, yawDelta: 0, moves: false };
    }
    const beforePlacement = placeOnPlane(camera, before.rle, object.start[2]);
    // Mask centres sit a little off the body centre (we see the top and one side): carry the
    // offset measured on the real photo over to the imagined one.
    const bias: Vec3 = beforePlacement.center
      ? [object.start[0] - beforePlacement.center[0], object.start[1] - beforePlacement.center[1], 0]
      : [0, 0, 0];
    const to: Vec3 = option.center ? [option.center[0] + bias[0], option.center[1] + bias[1], object.start[2]] : object.start;
    const distanceM = distance2d(to, object.start);
    const turn = option.heading !== null && beforePlacement.heading !== null ? headingDelta(beforePlacement.heading, option.heading) : 0;
    const yawDelta = Math.abs(turn) >= ROTATION_MIN ? turn : 0;
    const moves = distanceM >= STILL_M || yawDelta !== 0;
    if (option.ratio < AREA_RATIO_MIN || option.ratio > AREA_RATIO_MAX) {
      reasons.push(`${object.label} changed size (×${option.ratio.toFixed(2)})`);
    }
    const intent = input.intent?.get(object.name);
    if (intent === 'stay' && distanceM > UNASKED_MOVE_M) {
      reasons.push(`${object.label} moved ${(distanceM * 100).toFixed(0)} cm though it should stay`);
    } else if (intent === 'stay' && moves) {
      notes.push(`${object.label} drifted ${(distanceM * 100).toFixed(1)} cm`);
    } else if (intent === 'move' && !moves) {
      notes.push(`${object.label} was asked to move but stayed`);
    }
    if (moves && intent !== 'stay') {
      notes.push(`${object.label} moves ${(distanceM * 100).toFixed(1)} cm${yawDelta ? `, turns ${Math.round((yawDelta * 180) / Math.PI)}°` : ''}`);
    }
    return {
      name: object.name,
      label: object.label,
      found: true,
      source: option.source,
      mask: option.rle,
      areaRatio: option.ratio,
      from: object.start,
      to,
      distanceM,
      yawDelta,
      moves,
    };
  });

  if (input.beforeCounts) {
    for (const [concept, count] of input.beforeCounts) {
      const confident = new Set<string>();
      for (const s of input.segmented) {
        const object = objects.find((o) => o.name === s.name);
        if (object?.concept !== concept || s.source !== 'concept') continue;
        for (const m of s.masks) if ((m.confidence ?? 1) >= EXTRA_CONFIDENCE) confident.add(m.objectId);
      }
      if (confident.size > count) reasons.push(`an extra ${concept} appeared`);
    }
  }
  return { passed: reasons.length === 0, reasons, notes, goals };
}

/** Confident SAM instances per concept on the real photo, the baseline for "something appeared". */
export function conceptCounts(objects: SceneObject[], segmented: Segmented[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of segmented) {
    const object = objects.find((o) => o.name === s.name);
    if (!object || s.source !== 'concept') continue;
    const confident = s.masks.filter((m) => (m.confidence ?? 1) >= EXTRA_CONFIDENCE).length;
    counts.set(object.concept, Math.max(counts.get(object.concept) ?? 0, confident));
  }
  return counts;
}
