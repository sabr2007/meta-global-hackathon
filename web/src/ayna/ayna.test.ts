import { describe, expect, test } from 'vitest';
import { hitPlane, pixelRay, project, type PhotoCamera } from './camera';
import { checkPlan } from './dispatch';
import type { FleetRobot } from './fleet';
import { checkCandidate, headingDelta, type BeforeMask, type SceneObject, type Segmented } from './goals';
import { imageSize } from './images';
import { decodeRle, encodeRle, iou, maskStats, scaleRle, type Rle } from './rle';

// A camera 1 m above the table origin looking straight down; image x = world +x, image y = world -y.
const camera: PhotoCamera = {
  image: 'hero.jpg',
  width: 400,
  height: 400,
  fx: 400,
  fy: 400,
  cx: 200,
  cy: 200,
  camera_to_world: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 1],
    [0, 0, 0, 1],
  ],
};

function square(cx: number, cy: number, half: number): Rle {
  const w = half * 2;
  return encodeRle(new Uint8Array(w * w).fill(1), cx - half, cy - half, w, w);
}

describe('rle', () => {
  test('round trips and measures', () => {
    const raster = Uint8Array.from([1, 1, 0, 0, 1, 0]);
    const rle = encodeRle(raster, 5, 7, 3, 2);
    expect(rle.counts).toEqual([0, 2, 2, 1, 1]);
    expect(Array.from(decodeRle(rle))).toEqual(Array.from(raster));
    expect(maskStats(rle)).toMatchObject({ area: 3, box: [5, 7, 7, 9] });
  });

  test('iou and scaling', () => {
    expect(iou(square(50, 50, 10), square(50, 50, 10))).toBe(1);
    expect(iou(square(50, 50, 10), square(60, 50, 10))).toBeCloseTo(1 / 3, 2);
    const doubled = scaleRle(square(50, 50, 10), 2, 2);
    expect(maskStats(doubled).area).toBe(1600);
  });
});

describe('camera', () => {
  test('projects and casts rays consistently', () => {
    const p = project(camera, [0.1, 0.05, 0]);
    expect(p.x).toBeCloseTo(240);
    expect(p.y).toBeCloseTo(180);
    expect(p.depth).toBeCloseTo(1);
    const hit = hitPlane(pixelRay(camera, p.x, p.y), 0)!;
    expect(hit[0]).toBeCloseTo(0.1);
    expect(hit[1]).toBeCloseTo(0.05);
  });

  test('heading delta is symmetric modulo pi', () => {
    expect(headingDelta(0.1, Math.PI + 0.2)).toBeCloseTo(0.1);
    expect(headingDelta(1.5, -1.5)).toBeCloseTo(Math.PI - 3);
  });
});

describe('candidate check', () => {
  const objects: SceneObject[] = [
    { name: 'a', label: 'red cube', concept: 'red cube', size_m: [0.05, 0.05, 0.05], start: [0, 0, 0] },
    { name: 'b', label: 'blue cup', concept: 'blue cup', size_m: [0.05, 0.05, 0.05], start: [0.1, 0, 0] },
  ];
  const before: BeforeMask[] = [
    { object: 'a', concept: 'red cube', area_px: 400, rle: square(200, 200, 10) },
    { object: 'b', concept: 'blue cup', area_px: 400, rle: square(240, 200, 10) },
  ];
  const seg = (a: Rle | null, b: Rle | null): Segmented[] => [
    { name: 'a', source: a ? 'concept' : 'none', masks: a ? [{ objectId: '0', confidence: 0.9, area: 400, rle: a }] : [] },
    { name: 'b', source: b ? 'concept' : 'none', masks: b ? [{ objectId: '0', confidence: 0.9, area: 400, rle: b }] : [] },
  ];

  test('measures a move in metres', () => {
    const check = checkCandidate({ camera, objects, before, segmented: seg(square(200, 160, 10), square(240, 200, 10)), imageSize: { width: 400, height: 400 } });
    expect(check.passed).toBe(true);
    const a = check.goals.find((g) => g.name === 'a')!;
    expect(a.moves).toBe(true);
    expect(a.to[1]).toBeCloseTo(0.1, 2); // 40 px up at 1 m with f = 400 px
    expect(check.goals.find((g) => g.name === 'b')!.moves).toBe(false);
  });

  test('rejects a missing object and a resized one', () => {
    const check = checkCandidate({ camera, objects, before, segmented: seg(null, square(240, 200, 14)), imageSize: { width: 400, height: 400 } });
    expect(check.passed).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/red cube is missing/);
    expect(check.reasons.join(' ')).toMatch(/blue cup changed size/);
  });

  test('works across image sizes', () => {
    const half = scaleRle(square(200, 160, 10), 0.5, 0.5);
    const check = checkCandidate({ camera, objects, before, segmented: seg(half, scaleRle(square(240, 200, 10), 0.5, 0.5)), imageSize: { width: 200, height: 200 } });
    expect(check.passed).toBe(true);
    expect(check.goals[0].distanceM).toBeCloseTo(0.1, 2);
  });
});

describe('plan check', () => {
  const robot = (id: string, reach: (name: string) => boolean): FleetRobot => ({
    id,
    kind: id === 'mobile' ? 'mobile' : 'arm',
    label: id,
    gripWidthM: 0.11,
    reachOf: (name) => ({ ok: reach(name), reason: reach(name) ? 'ok' : '0.80 m away, reach 0.76 m', distanceM: 0.5 }),
    reachPoint: () => ({ ok: true, reason: 'ok', distanceM: 0.5 }),
    run: async () => ({ ok: true, reason: 'done' }),
    update: () => {},
    reset: () => {},
    status: () => 'Ready',
  });
  const goal = (name: string) => ({ name, label: name, found: true, source: 'concept' as const, mask: null, areaRatio: 1, from: [0, 0, 0] as [number, number, number], to: [0.1, 0, 0] as [number, number, number], distanceM: 0.1, yawDelta: 0, moves: true });

  test('reassigns, refuses and adds what Spark got wrong', () => {
    const fleet = [robot('arm', (n) => n !== 'far'), robot('mobile', () => true)];
    const plan = { steps: [{ object: 'far', robot: 'arm', why: '' }], refusals: [], order_reason: '' };
    const checked = checkPlan(plan, [goal('far'), goal('near')], fleet);
    expect(checked.steps.map((s) => [s.object, s.robot])).toEqual([
      ['far', 'mobile'],
      ['near', 'arm'],
    ]);
    expect(checked.fixes).toHaveLength(2);
    const preferArm = checkPlan({ steps: [{ object: 'near', robot: 'mobile', why: '' }], refusals: [], order_reason: '' }, [goal('near')], fleet);
    expect(preferArm.steps[0].robot).toBe('arm');
    const alone = checkPlan(plan, [goal('far')], [robot('arm', (n) => n !== 'far')]);
    expect(alone.refusals[0].reason).toMatch(/0.80 m away/);
  });
});

test('reads image sizes from headers', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGNgYGD4z8DAwMDAAAAMAAH1D7m3AAAAAElFTkSuQmCC';
  expect(await imageSize(png)).toEqual({ width: 3, height: 2 });
});

describe('step order', () => {
  test('a step waits for the object standing on its target', async () => {
    const { orderSteps } = await import('./dispatch');
    const step = (object: string) => ({ object, label: object, robot: 'arm', why: '', x: 0, y: 0, yawDelta: 0 });
    const ordered = orderSteps([step('ring'), step('figurine'), step('cup')], new Map([['ring', ['figurine']], ['figurine', []], ['cup', []]]));
    expect(ordered.steps.map((s) => s.object)).toEqual(['figurine', 'ring', 'cup']);
    expect(ordered.moved).toEqual(['figurine']);
    const cycle = orderSteps([step('a'), step('b')], new Map([['a', ['b']], ['b', ['a']]]));
    expect(cycle.steps.map((s) => s.object)).toEqual(['a', 'b']);
  });
});

describe('size check', () => {
  // The camera looks along the table at an angle, so moving away shrinks an object's image.
  const tilted: PhotoCamera = {
    ...camera,
    camera_to_world: [
      [1, 0, 0, 0],
      [0, 0.8, -0.6, -0.6],
      [0, 0.6, 0.8, 0.8],
      [0, 0, 0, 1],
    ],
  };
  const objects: SceneObject[] = [{ name: 'a', label: 'cup', concept: 'cup', size_m: [0.05, 0.05, 0.05], start: [0, 0, 0] }];
  const near = project(tilted, [0, 0, 0]);
  const far = project(tilted, [0, 0.3, 0]);
  const before: BeforeMask[] = [{ object: 'a', concept: 'cup', area_px: 400, rle: square(Math.round(near.x), Math.round(near.y), 10) }];
  const at = (x: number, y: number, half: number): Segmented[] => [{ name: 'a', source: 'concept', masks: [{ objectId: '0', confidence: 0.9, area: 4 * half * half, rle: square(Math.round(x), Math.round(y), half) }] }];

  test('accepts a move drawn at the same pixel size or with true perspective', () => {
    const same = checkCandidate({ camera: tilted, objects, before, segmented: at(far.x, far.y, 10), imageSize: { width: 400, height: 400 } });
    expect(same.passed).toBe(true);
    const scale = near.depth / far.depth;
    const perspective = checkCandidate({ camera: tilted, objects, before, segmented: at(far.x, far.y, Math.round(10 * scale)), imageSize: { width: 400, height: 400 } });
    expect(perspective.passed).toBe(true);
  });

  test('rejects an object resized beyond both readings', () => {
    const shrunk = checkCandidate({ camera: tilted, objects, before, segmented: at(near.x, near.y, 6), imageSize: { width: 400, height: 400 } });
    expect(shrunk.reasons.join(' ')).toMatch(/changed size/);
  });
});

describe('feasibility', () => {
  const goal = (name: string, moves: boolean, to: [number, number, number]) => ({
    name,
    label: name,
    found: true,
    source: 'concept' as const,
    mask: null,
    areaRatio: 1,
    from: [0, 0, 0] as [number, number, number],
    to,
    distanceM: 0.1,
    yawDelta: 0,
    moves,
  });
  const reachUpTo = (limit: number): FleetRobot => ({
    id: 'arm',
    kind: 'arm',
    label: 'Arm',
    gripWidthM: 0.11,
    reachOf: () => ({ ok: true, reason: 'ok', distanceM: 0.3 }),
    reachPoint: (x: number) => (x <= limit ? { ok: true, reason: 'ok', distanceM: x } : { ok: false, reason: `${x.toFixed(2)} m away, reach ${limit} m`, distanceM: x }),
    run: async () => ({ ok: true, reason: 'done' }),
    update: () => {},
    reset: () => {},
    status: () => 'Ready',
  });

  test('a goal out of every robot reach makes the version infeasible', async () => {
    const { infeasible } = await import('./dispatch');
    const reasons = infeasible([goal('cup', true, [0.9, 0, 0])], [reachUpTo(0.76)], new Map());
    expect(reasons[0]).toMatch(/no robot can move the cup there \(Arm: 0.90 m away/);
    expect(infeasible([goal('cup', true, [0.5, 0, 0])], [reachUpTo(0.76)], new Map())).toEqual([]);
  });

  test('a goal on top of an object that stays is infeasible, one that moves away is not', async () => {
    const { infeasible } = await import('./dispatch');
    const footprints = new Map<string, [number, number][]>([
      ['cup', [[0, 0]]],
      ['book', [[0.2, 0]]],
    ]);
    const onBook = [goal('cup', true, [0.2, 0, 0]), goal('book', false, [0, 0, 0])];
    expect(infeasible(onBook, [reachUpTo(0.76)], footprints).join(' ')).toMatch(/cup would land on the book/);
    const bookMoves = [goal('cup', true, [0.2, 0, 0]), { ...goal('book', true, [0.4, 0, 0]), from: [0.2, 0, 0] as [number, number, number] }];
    expect(infeasible(bookMoves, [reachUpTo(0.76)], footprints)).toEqual([]);
  });
});
