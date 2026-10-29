import type { SceneMeta } from '../scene/bundle';
import { components, cutOpenings, NavGrid, type Rect, type Vec2 } from './navigation';
import type { Physics } from './physics';

// What robots need to know about the room: RoomPlan element footprints (read from the compiled
// model, so they are exact), the scanned floor outline, the navigation grid, and the surface
// under any point (a ray cast that sees tables, furniture, the floor and scanned objects).

const MAX_OBSTACLE_BOTTOM_M = 1.6; // a shelf higher than this does not block a robot base (pipeline navgrid.py)
const RAY_START_Z = 3.0;
// Geom groups a downward ray sees: probes, structure, furniture, scanned objects; not openings or robots.
const RAY_GROUPS = [1, 1, 1, 0, 1, 0];
// RoomPlan boxes whose top is not a surface (a chair's box includes the air around its backrest).
const NOT_SURFACES = new Set(['chair', 'sofa', 'television', 'toilet', 'bathtub', 'fireplace', 'stairs']);
const FLAT_M = 0.015; // a footprint rests flat when the surface under it varies less than this
const FOOTPRINT_SAMPLES = 8;

export interface ElementBox {
  name: string;
  kind: string;
  category: string;
  collides: boolean;
  rect: Rect;
  bottom: number;
  top: number;
}

export interface Surface {
  z: number;
  geom: number;
  name: string;
  /** The scanned object hit, when the point is on top of one. */
  object: string | null;
}

function elementBox(physics: Physics, name: string, kind: string, category: string, collides: boolean): ElementBox | null {
  const { mujoco, model, data } = physics;
  const geom = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, name);
  if (geom < 0) return null;
  const p = data.geom_xpos.subarray(geom * 3, geom * 3 + 3);
  const m = data.geom_xmat.subarray(geom * 9, geom * 9 + 9); // row-major; columns are the local axes
  const size = model.geom_size.subarray(geom * 3, geom * 3 + 3);
  let vertical = 0;
  for (let k = 1; k < 3; k += 1) if (Math.abs(m[6 + k]) > Math.abs(m[6 + vertical])) vertical = k;
  const [a, b] = [0, 1, 2].filter((k) => k !== vertical);
  const ux = m[a];
  const uy = m[3 + a];
  const norm = Math.hypot(ux, uy) || 1;
  const halfHeight = Math.abs(m[6]) * size[0] + Math.abs(m[7]) * size[1] + Math.abs(m[8]) * size[2];
  return {
    name,
    kind,
    category,
    collides,
    rect: { x: p[0], y: p[1], ux: ux / norm, uy: uy / norm, hu: size[a], hv: size[b], name },
    bottom: p[2] - halfHeight,
    top: p[2] + halfHeight,
  };
}

export class SceneGeometry {
  readonly elements: ElementBox[];
  readonly floor: Vec2[] | null;
  private readonly objectBodies: Map<number, string>;
  private grid: NavGrid | null = null;
  private readonly regions = new Map<number, Int32Array>();

  constructor(
    private readonly physics: Physics,
    meta: SceneMeta,
  ) {
    const { mujoco, model } = physics;
    this.elements = meta.elements
      .map((e) => elementBox(physics, e.name, e.kind, e.category, e.collides))
      .filter((e): e is ElementBox => e !== null);
    const polygon = meta.room.floor_polygon;
    this.floor = polygon && polygon.length >= 3 ? polygon.map(([x, y]) => [x, y] as Vec2) : null;
    this.objectBodies = new Map();
    for (const o of meta.objects ?? []) {
      const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, o.body);
      if (body >= 0) this.objectBodies.set(body, o.name);
    }
  }

  /** Walls with their doors and openings cut out. */
  walls(): Rect[] {
    const gaps = this.elements.filter((e) => e.kind === 'door' || e.kind === 'opening').map((e) => e.rect);
    return this.elements.filter((e) => e.kind === 'wall' && e.collides).flatMap((e) => cutOpenings(e.rect, gaps));
  }

  /** Footprints a robot base keeps out of: walls and furniture (tables included) below its height. */
  obstacles(): Rect[] {
    const furniture = this.elements.filter((e) => e.kind === 'object' && e.collides && e.bottom < MAX_OBSTACLE_BOTTOM_M);
    return [...this.walls(), ...furniture.map((e) => e.rect)];
  }

  /** Surfaces an arm can stand on: RoomPlan tables (and the stands under scanned objects). */
  tables(): ElementBox[] {
    return this.elements.filter((e) => e.kind === 'object' && e.category === 'table' && e.collides);
  }

  navGrid(): NavGrid {
    this.grid ??= NavGrid.build(this.obstacles(), { floor: this.floor });
    return this.grid;
  }

  /** Connected free regions of the grid for a disc of `radius` (cached per radius). */
  regionsFor(radius: number): Int32Array {
    let labels = this.regions.get(radius);
    if (!labels) {
      labels = components(this.navGrid(), radius);
      this.regions.set(radius, labels);
    }
    return labels;
  }

  /** The highest surface straight below (x, y), ignoring robots and the body `exclude`. */
  surfaceUnder(x: number, y: number, exclude = -1): Surface | null {
    const { mujoco, model, data } = this.physics;
    const geomId = new mujoco.IntBuffer(1);
    const normal = new mujoco.DoubleBuffer(3);
    try {
      const distance = mujoco.mj_ray(model, data, [x, y, RAY_START_Z], [0, 0, -1], RAY_GROUPS, true, exclude, geomId, normal);
      const geom: number = geomId.GetView()[0];
      if (distance < 0 || geom < 0) return null;
      const body: number = model.geom_bodyid[geom];
      return {
        z: RAY_START_Z - distance,
        geom,
        name: mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, geom) ?? `geom_${geom}`,
        object: this.objectBodies.get(body) ?? null,
      };
    } finally {
      geomId.delete();
      normal.delete();
    }
  }

  /** Where an object of footprint `radius` can be put down at (x, y): the surface under its centre
   * when the whole footprint rests flat on it (or on top of another object), else why not. */
  placeSurface(x: number, y: number, radius: number, exclude = -1): Surface | string {
    const where = `(${x.toFixed(2)}, ${y.toFixed(2)})`;
    const center = this.surfaceUnder(x, y, exclude);
    if (!center) return `nothing to stand on at ${where}`;
    const element = this.element(center.name);
    if (element && (element.kind === 'wall' || NOT_SURFACES.has(element.category))) {
      return `${where} is on a ${element.kind === 'wall' ? 'wall' : `RoomPlan box around a ${element.category}`}, not a surface`;
    }
    if (center.object) return center; // stacking: the object below decides
    for (let k = 0; k < FOOTPRINT_SAMPLES; k += 1) {
      const angle = (2 * Math.PI * k) / FOOTPRINT_SAMPLES;
      const rim = this.surfaceUnder(x + radius * Math.cos(angle), y + radius * Math.sin(angle), exclude);
      if (!rim || rim.z < center.z - FLAT_M) return `${where} is at the edge of ${center.name}`;
      if (rim.z > center.z + FLAT_M) return `${where} is too close to ${rim.object ?? rim.name}`;
    }
    return center;
  }

  /** The RoomPlan element a surface belongs to, if any (e.g. "table_0"). */
  element(name: string): ElementBox | undefined {
    return this.elements.find((e) => e.name === name);
  }
}

/** Whether a disc lies fully on a rectangle's footprint. */
export function discOnRect(r: Rect, x: number, y: number, radius: number): boolean {
  const dx = x - r.x;
  const dy = y - r.y;
  const along = Math.abs(dx * r.ux + dy * r.uy);
  const across = Math.abs(dy * r.ux - dx * r.uy);
  return along + radius <= r.hu && across + radius <= r.hv;
}
