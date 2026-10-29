import { describe, expect, test } from 'vitest';
import {
  NavGrid,
  canPark,
  components,
  cutOpenings,
  distanceField,
  findPath,
  parkingSpots,
  pathLength,
  rect,
  shortcut,
  type Rect,
  type Vec2,
} from './navigation';

// A 6 m x 4 m room (walls 10 cm thick) around the origin.
const ROOM: Rect[] = [
  rect(0, 2.05, 0, 3.1, 0.05, 'north'),
  rect(0, -2.05, 0, 3.1, 0.05, 'south'),
  rect(3.05, 0, Math.PI / 2, 2.1, 0.05, 'east'),
  rect(-3.05, 0, Math.PI / 2, 2.1, 0.05, 'west'),
];
const RADIUS = 0.28;

function clearAlong(grid: NavGrid, path: readonly Vec2[], radius: number): boolean {
  return path.every((p, k) => k === 0 || grid.segmentClear(path[k - 1], p, radius - 1e-6));
}

describe('navigation grid', () => {
  test('A* goes around a wall through the gap at its end', () => {
    // A wall across the room from the south wall up to y = 1.2, leaving a 0.8 m gap in the north.
    const divider = rect(0, -0.4, Math.PI / 2, 1.6, 0.05, 'divider');
    const grid = NavGrid.build([...ROOM, divider]);
    const start: Vec2 = [-2, -1];
    const goal: Vec2 = [2, -1];
    const { path, reason } = findPath(grid, start, goal, RADIUS);
    expect(reason).toBe('ok');
    expect(path).not.toBeNull();
    expect(path![0]).toEqual([-2, -1]);
    expect(path![path!.length - 1]).toEqual([2, -1]);
    expect(Math.max(...path!.map((p) => p[1]))).toBeGreaterThan(1.2); // through the gap
    expect(pathLength(path!)).toBeGreaterThan(6); // up and over (the straight line is 4 m)
    const smooth = shortcut(grid, path!, RADIUS);
    expect(smooth.length).toBeLessThan(path!.length);
    expect(clearAlong(grid, smooth, RADIUS)).toBe(true);
    expect(pathLength(smooth)).toBeLessThanOrEqual(pathLength(path!));
  });

  test('refuses a goal that is enclosed', () => {
    const pen = [rect(1.5, 0.8, 0, 0.6, 0.05), rect(1.5, -0.8, 0, 0.6, 0.05), rect(0.95, 0, Math.PI / 2, 0.85, 0.05), rect(2.05, 0, Math.PI / 2, 0.85, 0.05)];
    const grid = NavGrid.build([...ROOM, ...pen]);
    const { path, reason } = findPath(grid, [-2, 0], [1.5, 0], RADIUS);
    expect(path).toBeNull();
    expect(reason).toMatch(/enclosed/);
  });

  test('a gap narrower than the robot is closed', () => {
    // A 0.5 m gap (y from 0 to 0.5): a 0.56 m wide robot does not fit, a 0.3 m one does.
    const left = rect(0, 1.275, Math.PI / 2, 0.775, 0.05);
    const right = rect(0, -1.025, Math.PI / 2, 1.025, 0.05);
    const grid = NavGrid.build([...ROOM, left, right]);
    expect(findPath(grid, [-2, 0], [2, 0], RADIUS).path).toBeNull();
    expect(findPath(grid, [-2, 0], [2, 0], 0.15).path).not.toBeNull();
  });

  test('doors are cut out of their wall', () => {
    const divider = rect(0, 0, Math.PI / 2, 2.0, 0.05, 'divider');
    const door = rect(0, -0.5, Math.PI / 2, 0.45, 0.01, 'door');
    const pieces = cutOpenings(divider, [door]);
    expect(pieces).toHaveLength(2);
    const closed = NavGrid.build([...ROOM, divider]);
    const open = NavGrid.build([...ROOM, ...pieces]);
    expect(findPath(closed, [-2, 0], [2, 0], 0.2).path).toBeNull();
    const { path } = findPath(open, [-2, 0], [2, 0], 0.2);
    expect(path).not.toBeNull();
    expect(path!.some(([x, y]) => Math.abs(x) < 0.05 && Math.abs(y + 0.5) < 0.3)).toBe(true);
  });

  test('cells outside the floor outline are blocked', () => {
    const floor: Vec2[] = [
      [-3, -2],
      [3, -2],
      [3, 2],
      [-3, 2],
    ];
    const grid = NavGrid.build([], { floor });
    expect(grid.clearanceAt(0, 0)).toBeCloseTo(2, 1);
    expect(grid.clearanceAt(2.9, 0)).toBeLessThan(0.11);
    expect(findPath(grid, [0, 0], [2.9, 0], RADIUS).path).toBeNull();
  });

  test('parks next to a table so the arm reaches a point on it', () => {
    const table = rect(1.5, 0, 0, 0.5, 0.4, 'table');
    const grid = NavGrid.build([...ROOM, table]);
    const field = distanceField(grid, [-2, 0], RADIUS)!;
    const query = { target: [1.5, 0.2] as Vec2, reach: [0.3, 0.72] as const, preferred: 0.5, armOffset: 0.14, radius: RADIUS, blockers: ROOM };
    const [best] = parkingSpots(field, query);
    expect(best).toBeDefined();
    expect(grid.free(best.index, RADIUS)).toBe(true);
    expect(best.armDistance).toBeGreaterThanOrEqual(0.3);
    expect(best.armDistance).toBeLessThanOrEqual(0.72);
    // Facing the target, from the side the robot comes from.
    expect(best.x).toBeLessThan(1.0);
    expect(Math.abs(Math.atan2(0.2 - best.y, 1.5 - best.x) - best.yaw)).toBeLessThan(1e-9);
    const labels = components(grid, RADIUS);
    expect(canPark(grid, labels, [-2, 0], query)).not.toBeNull();
    // Out of every spot's reach: the middle of a table that is too deep.
    const wide = rect(1.5, 0, 0, 1.2, 1.6, 'wide table');
    const blocked = NavGrid.build([...ROOM, wide]);
    expect(canPark(blocked, components(blocked, RADIUS), [-2.5, 0], { ...query, target: [1.6, 0] })).toBeNull();
  });
});
