import type { Vec3 } from './ik';
import type { Physics } from './physics';

/** A scanned object's collider (its convex hull) as it is now, seen by a top-down gripper. */
export interface ObjectShape {
  center: Vec3; // centre of the footprint, half height
  bottom: number;
  top: number;
  yaw: number; // direction of the narrowest horizontal extent (the gripper closes along it)
  width: number; // extent along yaw
  length: number; // extent across yaw
  radius: number; // farthest hull point from the centre, horizontally
}

export function objectGeom(physics: Physics, name: string): number {
  const { mujoco, model } = physics;
  const geom = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, `${name}_geom`);
  if (geom < 0) throw new Error(`scene.xml has no collider named ${name}_geom`);
  return geom;
}

/** World vertices of the object's hull, as it lies now. */
function hullPoints(physics: Physics, name: string): number[][] {
  const { model, data } = physics;
  const geom = objectGeom(physics, name);
  const mesh: number = model.geom_dataid[geom];
  const adr: number = model.mesh_vertadr[mesh];
  const count: number = model.mesh_vertnum[mesh];
  const verts = model.mesh_vert.subarray(adr * 3, (adr + count) * 3);
  const p = data.geom_xpos.subarray(geom * 3, geom * 3 + 3);
  const r = data.geom_xmat.subarray(geom * 9, geom * 9 + 9);
  const world: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const v = [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
    world.push([0, 1, 2].map((row) => p[row] + r[row * 3] * v[0] + r[row * 3 + 1] * v[1] + r[row * 3 + 2] * v[2]));
  }
  return world;
}

export function objectShape(physics: Physics, name: string): ObjectShape {
  const world = hullPoints(physics, name);
  const count = world.length;
  const zs = world.map((w) => w[2]);
  // Principal axes of the footprint; the gripper closes along the minor one.
  const mx = world.reduce((s, w) => s + w[0], 0) / count;
  const my = world.reduce((s, w) => s + w[1], 0) / count;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of world) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const major = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const yaw = major + Math.PI / 2;
  const extent = (angle: number): [number, number] => {
    const proj = world.map(([x, y]) => x * Math.cos(angle) + y * Math.sin(angle));
    return [Math.min(...proj), Math.max(...proj)];
  };
  const [minorLo, minorHi] = extent(yaw);
  const [majorLo, majorHi] = extent(major);
  const u = (majorLo + majorHi) / 2;
  const v = (minorLo + minorHi) / 2;
  const cx = u * Math.cos(major) + v * Math.cos(yaw);
  const cy = u * Math.sin(major) + v * Math.sin(yaw);
  const bottom = Math.min(...zs);
  const top = Math.max(...zs);
  const radius = Math.max(...world.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  return { center: [cx, cy, (bottom + top) / 2], bottom, top, yaw, width: minorHi - minorLo, length: majorHi - majorLo, radius };
}
