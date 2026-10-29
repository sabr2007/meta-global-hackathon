// Planar navigation for a robot base: a 5 cm grid where every cell knows how far it is from the
// nearest obstacle (or the edge of the scanned floor), Dijkstra/A* over the cells a disc of a
// given radius fits in, path shortcuts, and parking spots from which an arm reaches a point.
// Pure geometry: tests build grids from rectangles; sceneGeometry.ts builds them from a scene.

export type Vec2 = readonly [number, number];

/** Oriented rectangle seen from above: centre, unit axis u, half sizes along u and its normal. */
export interface Rect {
  x: number;
  y: number;
  ux: number;
  uy: number;
  hu: number;
  hv: number;
  name?: string;
}

export const CELL_M = 0.05;
const PADDING_M = 0.5; // grid margin around the obstacles when there is no floor outline
const SQRT2 = Math.SQRT2;
// Paths prefer to keep this much more than the robot radius from obstacles (cost rises closer in).
const COMFORT_BAND_M = 0.25;
const COMFORT_WEIGHT = 1.5;
const ESCAPE_RADIUS_M = 0.5; // a start inside the inflated zone may leave it within this distance

const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

export function rect(x: number, y: number, yaw: number, halfU: number, halfV: number, name?: string): Rect {
  return { x, y, ux: Math.cos(yaw), uy: Math.sin(yaw), hu: halfU, hv: halfV, name };
}

/** Horizontal distance from a point to the rectangle (0 inside). */
export function rectDistance(r: Rect, x: number, y: number): number {
  const dx = x - r.x;
  const dy = y - r.y;
  const a = Math.abs(dx * r.ux + dy * r.uy) - r.hu;
  const b = Math.abs(dy * r.ux - dx * r.uy) - r.hv;
  return Math.hypot(Math.max(a, 0), Math.max(b, 0));
}

/** A wall with its doors (and doorless openings) cut out, as up to several pieces. */
export function cutOpenings(wall: Rect, openings: readonly Rect[]): Rect[] {
  const spans: [number, number][] = [];
  for (const o of openings) {
    const along = (o.x - wall.x) * wall.ux + (o.y - wall.y) * wall.uy;
    const across = Math.abs((o.y - wall.y) * wall.ux - (o.x - wall.x) * wall.uy);
    if (across > wall.hv + 0.15) continue; // not in this wall
    const parallel = Math.abs(o.ux * wall.ux + o.uy * wall.uy) > 0.9;
    const half = parallel ? o.hu : o.hv;
    spans.push([along - half, along + half]);
  }
  if (spans.length === 0) return [wall];
  spans.sort((a, b) => a[0] - b[0]);
  const pieces: Rect[] = [];
  let start = -wall.hu;
  const piece = (from: number, to: number): void => {
    if (to - from < 0.02) return;
    const mid = (from + to) / 2;
    pieces.push({ ...wall, x: wall.x + wall.ux * mid, y: wall.y + wall.uy * mid, hu: (to - from) / 2 });
  };
  for (const [lo, hi] of spans) {
    piece(start, Math.min(lo, wall.hu));
    start = Math.max(start, hi);
  }
  piece(start, wall.hu);
  return pieces;
}

export function insidePolygon(polygon: readonly Vec2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) inside = !inside;
  }
  return inside;
}

function segmentDistance(x: number, y: number, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const t = Math.min(Math.max(((x - a[0]) * abx + (y - a[1]) * aby) / Math.max(abx * abx + aby * aby, 1e-12), 0), 1);
  return Math.hypot(x - (a[0] + t * abx), y - (a[1] + t * aby));
}

export interface GridOptions {
  cell?: number;
  /** Scanned floor outline: cells outside it are blocked, its edges count as obstacles. */
  floor?: readonly Vec2[] | null;
}

export class NavGrid {
  private constructor(
    readonly originX: number,
    readonly originY: number,
    readonly cell: number,
    readonly nx: number,
    readonly ny: number,
    /** Distance from each cell centre to the nearest obstacle or floor edge; 0 when blocked. */
    readonly clearance: Float32Array,
  ) {}

  static build(obstacles: readonly Rect[], options: GridOptions = {}): NavGrid {
    const cell = options.cell ?? CELL_M;
    const floor = options.floor && options.floor.length >= 3 ? options.floor : null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const extend = (x: number, y: number): void => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };
    if (floor) {
      for (const [x, y] of floor) extend(x, y);
    } else {
      for (const r of obstacles) {
        const ex = Math.abs(r.ux) * r.hu + Math.abs(r.uy) * r.hv;
        const ey = Math.abs(r.uy) * r.hu + Math.abs(r.ux) * r.hv;
        extend(r.x - ex - PADDING_M, r.y - ey - PADDING_M);
        extend(r.x + ex + PADDING_M, r.y + ey + PADDING_M);
      }
    }
    if (!Number.isFinite(minX)) throw new Error('navigation grid needs obstacles or a floor outline');
    const nx = Math.max(1, Math.ceil((maxX - minX) / cell));
    const ny = Math.max(1, Math.ceil((maxY - minY) / cell));
    const clearance = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j += 1) {
      const y = minY + (j + 0.5) * cell;
      for (let i = 0; i < nx; i += 1) {
        const x = minX + (i + 0.5) * cell;
        let free = Infinity;
        for (const r of obstacles) {
          const d = rectDistance(r, x, y);
          if (d < free) free = d;
          if (free === 0) break;
        }
        if (floor && free > 0) {
          if (!insidePolygon(floor, x, y)) free = 0;
          else for (let k = 0, m = floor.length - 1; k < floor.length; m = k, k += 1) free = Math.min(free, segmentDistance(x, y, floor[m], floor[k]));
        }
        clearance[j * nx + i] = Number.isFinite(free) ? free : 1e3;
      }
    }
    return new NavGrid(minX, minY, cell, nx, ny, clearance);
  }

  get size(): number {
    return this.nx * this.ny;
  }

  /** Cell index of a point, or -1 outside the grid. */
  cellAt(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const i = Math.floor((x - this.originX) / this.cell);
    const j = Math.floor((y - this.originY) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1;
    return j * this.nx + i;
  }

  centerOf(index: number): [number, number] {
    const i = index % this.nx;
    const j = (index - i) / this.nx;
    return [this.originX + (i + 0.5) * this.cell, this.originY + (j + 0.5) * this.cell];
  }

  clearanceAt(x: number, y: number): number {
    const index = this.cellAt(x, y);
    return index < 0 ? 0 : this.clearance[index];
  }

  free(index: number, radius: number): boolean {
    return index >= 0 && this.clearance[index] >= radius;
  }

  /** Whether a disc of `radius` can slide along the straight segment a -> b. */
  segmentClear(a: Vec2, b: Vec2, radius: number): boolean {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(length / (this.cell / 2)));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      if (this.clearanceAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) < radius) return false;
    }
    return true;
  }

  /** Nearest cell a disc of `radius` fits in, within `maxDistance` of a point; -1 if none. */
  nearestFree(x: number, y: number, radius: number, maxDistance = ESCAPE_RADIUS_M): number {
    const reach = Math.ceil(maxDistance / this.cell);
    const ci = Math.floor((x - this.originX) / this.cell);
    const cj = Math.floor((y - this.originY) / this.cell);
    let best = -1;
    let bestDistance = Infinity;
    for (let j = Math.max(0, cj - reach); j <= Math.min(this.ny - 1, cj + reach); j += 1) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(this.nx - 1, ci + reach); i += 1) {
        const index = j * this.nx + i;
        if (this.clearance[index] < radius) continue;
        const [cx, cy] = this.centerOf(index);
        const d = Math.hypot(cx - x, cy - y);
        if (d <= maxDistance && d < bestDistance) {
          best = index;
          bestDistance = d;
        }
      }
    }
    return best;
  }

  /** Step cost multiplier: 1 in open space, higher close to obstacles. */
  stepWeight(index: number, radius: number): number {
    const spare = this.clearance[index] - radius;
    return 1 + COMFORT_WEIGHT * Math.max(0, 1 - spare / COMFORT_BAND_M);
  }
}

/** Binary min-heap of cell indices keyed by cost. */
class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get length(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}

/** Cost-to-come from one start over every reachable cell (Dijkstra), with parents for paths. */
export interface DistanceField {
  readonly grid: NavGrid;
  readonly radius: number;
  readonly from: Vec2;
  /** First free cell the search starts from (the start's own cell, or the nearest free one). */
  readonly root: number;
  readonly cost: Float64Array;
  readonly parent: Int32Array;
}

function expand(
  grid: NavGrid,
  radius: number,
  root: number,
  rootCost: number,
  goal: number,
  heuristic: (index: number) => number,
): { cost: Float64Array; parent: Int32Array } {
  const cost = new Float64Array(grid.size).fill(Infinity);
  const parent = new Int32Array(grid.size).fill(-1);
  const done = new Uint8Array(grid.size);
  const heap = new Heap();
  cost[root] = rootCost;
  heap.push(root, rootCost + heuristic(root));
  const { nx, ny, cell } = grid;
  while (heap.length > 0) {
    const current = heap.pop();
    if (done[current]) continue;
    done[current] = 1;
    if (current === goal) break;
    const i = current % nx;
    const j = (current - i) / nx;
    for (const [di, dj, step] of NEIGHBOURS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const next = nj * nx + ni;
      if (done[next] || !grid.free(next, radius)) continue;
      // No corner cutting: a diagonal step needs both side cells free.
      if (di !== 0 && dj !== 0 && (!grid.free(j * nx + ni, radius) || !grid.free(nj * nx + i, radius))) continue;
      const candidate = cost[current] + step * cell * grid.stepWeight(next, radius);
      if (candidate < cost[next]) {
        cost[next] = candidate;
        parent[next] = current;
        heap.push(next, candidate + heuristic(next));
      }
    }
  }
  return { cost, parent };
}

/** Where a search starts: the start's cell when the disc fits there, else the nearest cell it does. */
function rootCell(grid: NavGrid, from: Vec2, radius: number): number {
  const own = grid.cellAt(from[0], from[1]);
  if (grid.free(own, radius)) return own;
  return grid.nearestFree(from[0], from[1], radius);
}

export function distanceField(grid: NavGrid, from: Vec2, radius: number): DistanceField | null {
  const root = rootCell(grid, from, radius);
  if (root < 0) return null;
  const [rx, ry] = grid.centerOf(root);
  const { cost, parent } = expand(grid, radius, root, Math.hypot(rx - from[0], ry - from[1]), -1, () => 0);
  return { grid, radius, from, root, cost, parent };
}

/** Cell centres from the field's start to `goal`, starting at the exact start point. */
export function pathTo(field: DistanceField, goal: number): [number, number][] | null {
  if (!Number.isFinite(field.cost[goal])) return null;
  const cells: number[] = [];
  for (let c = goal; c !== -1; c = field.parent[c]) cells.push(c);
  cells.reverse();
  const points = cells.map((c) => field.grid.centerOf(c));
  return [[field.from[0], field.from[1]], ...points];
}

export interface PathResult {
  path: [number, number][] | null;
  reason: string;
}

/** A* from start to goal for a disc of `radius`; the path runs between the exact end points. */
export function findPath(grid: NavGrid, start: Vec2, goal: Vec2, radius: number): PathResult {
  const root = rootCell(grid, start, radius);
  if (root < 0) return { path: null, reason: 'the start is boxed in by obstacles' };
  const target = grid.cellAt(goal[0], goal[1]);
  if (target < 0) return { path: null, reason: 'the goal is off the map' };
  if (!grid.free(target, radius)) return { path: null, reason: 'the goal is too close to an obstacle' };
  const [rx, ry] = grid.centerOf(root);
  const [gx, gy] = grid.centerOf(target);
  const { cost, parent } = expand(grid, radius, root, Math.hypot(rx - start[0], ry - start[1]), target, (index) => {
    const [x, y] = grid.centerOf(index);
    return Math.hypot(x - gx, y - gy);
  });
  if (!Number.isFinite(cost[target])) return { path: null, reason: 'no way through: the goal is enclosed' };
  const field: DistanceField = { grid, radius, from: start, root, cost, parent };
  const path = pathTo(field, target)!;
  path.push([goal[0], goal[1]]);
  return { path, reason: 'ok' };
}

/** Drop waypoints the disc can skip in a straight line (greedy line of sight). */
export function shortcut(grid: NavGrid, path: readonly Vec2[], radius: number): [number, number][] {
  if (path.length <= 2) return path.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [[path[0][0], path[0][1]]];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let next = anchor + 1;
    for (let k = path.length - 1; k > anchor + 1; k -= 1) {
      if (grid.segmentClear(path[anchor], path[k], radius)) {
        next = k;
        break;
      }
    }
    out.push([path[next][0], path[next][1]]);
    anchor = next;
  }
  return out;
}

export function pathLength(path: readonly Vec2[]): number {
  let length = 0;
  for (let k = 1; k < path.length; k += 1) length += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
  return length;
}

/** Free cells grouped by connectivity (labels from 1; 0 = blocked) for a disc of `radius`. */
export function components(grid: NavGrid, radius: number): Int32Array {
  const label = new Int32Array(grid.size);
  const { nx, ny } = grid;
  let next = 0;
  const stack: number[] = [];
  for (let seed = 0; seed < grid.size; seed += 1) {
    if (label[seed] !== 0 || !grid.free(seed, radius)) continue;
    next += 1;
    label[seed] = next;
    stack.push(seed);
    while (stack.length > 0) {
      const current = stack.pop()!;
      const i = current % nx;
      const j = (current - i) / nx;
      for (const [di, dj] of NEIGHBOURS) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const n = nj * nx + ni;
        if (label[n] !== 0 || !grid.free(n, radius)) continue;
        if (di !== 0 && dj !== 0 && (!grid.free(j * nx + ni, radius) || !grid.free(nj * nx + i, radius))) continue;
        label[n] = next;
        stack.push(n);
      }
    }
  }
  return label;
}

/** Where to park so that an arm mounted `armOffset` ahead of the base centre reaches a point. */
export interface ParkingQuery {
  target: Vec2;
  /** Horizontal distance band from the arm's axis to the target. */
  reach: readonly [number, number];
  /** Distance the arm reaches best at; parking spots nearer to it win. */
  preferred: number;
  armOffset: number;
  radius: number;
  /** The arm must not reach through these (walls). */
  blockers?: readonly Rect[];
}

export interface Parking {
  index: number;
  x: number;
  y: number;
  yaw: number; // facing the target
  armDistance: number;
  pathCost: number;
  score: number;
}

const REACH_WEIGHT = 3; // metres of driving worth one metre away from the preferred reach

function sightClear(from: Vec2, to: Vec2, blockers: readonly Rect[]): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.03));
  for (let k = 0; k <= steps; k += 1) {
    const x = from[0] + ((to[0] - from[0]) * k) / steps;
    const y = from[1] + ((to[1] - from[1]) * k) / steps;
    for (const b of blockers) if (rectDistance(b, x, y) === 0) return false;
  }
  return true;
}

/** Visit every cell a disc fits in whose arm reaches the target (within the query band). */
function forEachSpot(grid: NavGrid, query: ParkingQuery, accept: (index: number) => boolean, visit: (p: Parking) => boolean | void): void {
  const [tx, ty] = query.target;
  const outer = query.reach[1] + query.armOffset;
  const r = Math.ceil(outer / grid.cell) + 1;
  const ci = Math.floor((tx - grid.originX) / grid.cell);
  const cj = Math.floor((ty - grid.originY) / grid.cell);
  for (let j = Math.max(0, cj - r); j <= Math.min(grid.ny - 1, cj + r); j += 1) {
    for (let i = Math.max(0, ci - r); i <= Math.min(grid.nx - 1, ci + r); i += 1) {
      const index = j * grid.nx + i;
      if (!grid.free(index, query.radius) || !accept(index)) continue;
      const [x, y] = grid.centerOf(index);
      const toTarget = Math.hypot(tx - x, ty - y);
      const armDistance = toTarget - query.armOffset;
      if (armDistance < query.reach[0] || armDistance > query.reach[1]) continue;
      const yaw = Math.atan2(ty - y, tx - x);
      const mount: Vec2 = [x + query.armOffset * Math.cos(yaw), y + query.armOffset * Math.sin(yaw)];
      if (query.blockers && !sightClear(mount, query.target, query.blockers)) continue;
      const stop = visit({ index, x, y, yaw, armDistance, pathCost: 0, score: Math.abs(armDistance - query.preferred) });
      if (stop) return;
    }
  }
}

/** Parking spots reachable in the field, best first (short drive, arm near its preferred reach). */
export function parkingSpots(field: DistanceField, query: ParkingQuery, limit = 8): Parking[] {
  const spots: Parking[] = [];
  forEachSpot(
    field.grid,
    query,
    (index) => Number.isFinite(field.cost[index]),
    (spot) => {
      const pathCost = field.cost[spot.index];
      spots.push({ ...spot, pathCost, score: pathCost + REACH_WEIGHT * spot.score });
    },
  );
  spots.sort((a, b) => a.score - b.score);
  // Keep spots at least two cells apart, so the alternatives differ.
  const picked: Parking[] = [];
  for (const s of spots) {
    if (picked.every((p) => Math.hypot(p.x - s.x, p.y - s.y) > 2 * field.grid.cell)) picked.push(s);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Cheap check (no path search): is there a parking spot in the same free region as `from`? */
export function canPark(grid: NavGrid, labels: Int32Array, from: Vec2, query: ParkingQuery): Parking | null {
  const root = rootCell(grid, from, query.radius);
  if (root < 0) return null;
  const region = labels[root];
  let best: Parking | null = null;
  forEachSpot(
    grid,
    query,
    (index) => labels[index] === region,
    (spot) => {
      if (!best || spot.score < best.score) best = spot;
    },
  );
  return best;
}
