import * as THREE from 'three';
import type { Physics } from '../sim/physics';
import { armMaterial, meshGeometry } from './armLook';

// Geom groups written by the pipeline (see pipeline/src/scan2sim/mjcf.py and arm.py).
// Group 4 holds the convex colliders of scanned objects; render/objects.ts draws their meshes.
// Group 5 is the robot arm; group 6 its invisible helpers (finger colliders, sites).
export const GROUP = { probes: 0, structure: 1, furniture: 2, openings: 3, scanned: 4, arm: 5 } as const;
export type GroupId = (typeof GROUP)[keyof typeof GROUP];
const DRAWN_GROUPS: ReadonlySet<number> = new Set([GROUP.probes, GROUP.structure, GROUP.furniture, GROUP.openings, GROUP.arm]);

const HIGHLIGHT_COLOR = new THREE.Color('#ff5a1f');
const EDGE_COLOR = new THREE.Color('#2b2a27');
const HIGHLIGHT_OPACITY = 0.55;
const HIGHLIGHT_RENDER_ORDER = 10;

interface GeomView {
  index: number;
  name: string;
  group: number;
  object: THREE.Object3D;
  material: THREE.MeshStandardMaterial;
  edges: THREE.LineSegments | null;
  baseColor: THREE.Color;
  baseOpacity: number;
}

export interface GeomLayer {
  readonly root: THREE.Group;
  sync(): void;
  setGroupVisible(group: GroupId, visible: boolean): void;
  /** Cut these groups with clipping planes (the stage around the table). */
  clip(groups: readonly GroupId[], planes: THREE.Plane[]): void;
  /** Repaint a group's geoms (all, or those whose name matches); highlight and tint return to this look. */
  paint(group: GroupId, color: string, opacity: number, only?: RegExp): void;
  highlight(name: string | null): void;
  /** Recolour geoms by name (a robot's status lights: lime when fine, orange when it needs
   * attention); null restores their own colour. */
  tint(names: readonly string[], color: string | null): void;
}

function geometryFor(type: number, size: ArrayLike<number>, physics: Physics): THREE.BufferGeometry | null {
  const types = physics.mujoco.mjtGeom;
  switch (type) {
    case types.mjGEOM_BOX.value:
      return new THREE.BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2);
    case types.mjGEOM_SPHERE.value:
      return new THREE.SphereGeometry(size[0], 32, 20);
    case types.mjGEOM_CYLINDER.value:
      // three.js cylinders run along Y, MuJoCo along Z.
      return new THREE.CylinderGeometry(size[0], size[0], size[1] * 2, 32).rotateX(Math.PI / 2);
    case types.mjGEOM_CAPSULE.value:
      return new THREE.CapsuleGeometry(size[0], size[1] * 2, 8, 24).rotateX(Math.PI / 2);
    default:
      return null; // planes are drawn by the scan mesh
  }
}

function createView(physics: Physics, index: number): GeomView | null {
  const { mujoco, model } = physics;
  const group: number = model.geom_group[index];
  if (!DRAWN_GROUPS.has(group)) return null;
  const type: number = model.geom_type[index];
  const isMesh = type === mujoco.mjtGeom.mjGEOM_MESH.value;
  const size = model.geom_size.subarray(index * 3, index * 3 + 3);
  const geometry = isMesh ? meshGeometry(physics, model.geom_dataid[index]) : geometryFor(type, size, physics);
  if (!geometry) return null;

  const rgba = model.geom_rgba.subarray(index * 4, index * 4 + 4);
  const isProxy = group !== GROUP.probes && group !== GROUP.arm;
  let material: THREE.MeshStandardMaterial;
  if (group === GROUP.arm) {
    material = armMaterial(physics, model.geom_matid[index]);
  } else {
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace),
      roughness: isProxy ? 0.9 : 0.45,
      metalness: 0,
      transparent: rgba[3] < 1,
      opacity: rgba[3],
      depthWrite: rgba[3] >= 1,
    });
  }
  const baseColor = material.color.clone();
  const baseOpacity = material.opacity;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = !isProxy;
  mesh.receiveShadow = true; // a RoomPlan table catches the shadows of the robots and objects on it

  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.add(mesh);

  let edges: THREE.LineSegments | null = null;
  if (isProxy) {
    edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.55 }),
    );
    object.add(edges);
  }

  const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, index) || `geom_${index}`;
  object.name = name;
  return { index, name, group, object, material, edges, baseColor, baseOpacity };
}

export function buildGeomLayer(physics: Physics): GeomLayer {
  const root = new THREE.Group();
  root.name = 'mujoco-geoms';
  const views: GeomView[] = [];
  for (let i = 0; i < physics.model.ngeom; i += 1) {
    const view = createView(physics, i);
    if (view) {
      views.push(view);
      root.add(view.object);
    }
  }

  const sync = (): void => {
    const pos = physics.data.geom_xpos;
    const mat = physics.data.geom_xmat;
    for (const v of views) {
      const p = v.index * 3;
      const r = v.index * 9; // row-major 3x3
      v.object.matrix.set(
        mat[r], mat[r + 1], mat[r + 2], pos[p],
        mat[r + 3], mat[r + 4], mat[r + 5], pos[p + 1],
        mat[r + 6], mat[r + 7], mat[r + 8], pos[p + 2],
        0, 0, 0, 1,
      );
      v.object.matrixWorldNeedsUpdate = true;
    }
  };

  const setGroupVisible = (group: GroupId, visible: boolean): void => {
    for (const v of views) {
      if (v.group === group) v.object.visible = visible;
    }
  };

  const clip = (groups: readonly GroupId[], planes: THREE.Plane[]): void => {
    const wanted = new Set<number>(groups);
    for (const v of views) {
      if (!wanted.has(v.group)) continue;
      v.material.clippingPlanes = planes;
      if (v.edges) (v.edges.material as THREE.LineBasicMaterial).clippingPlanes = planes;
    }
  };

  const paint = (group: GroupId, color: string, opacity: number, only?: RegExp): void => {
    for (const v of views) {
      if (v.group !== group || (only && !only.test(v.name))) continue;
      v.baseColor.set(color);
      v.baseOpacity = opacity;
      v.material.color.copy(v.baseColor);
      v.material.opacity = opacity;
      v.material.transparent = opacity < 1;
      v.material.depthWrite = opacity >= 1;
      v.material.needsUpdate = true;
    }
  };

  // The highlighted collider is drawn on top of everything ("x-ray"), because
  // colliders usually sit inside the scanned surfaces they approximate.
  const highlight = (name: string | null): void => {
    for (const v of views) {
      const active = v.name === name;
      v.material.color.copy(active ? HIGHLIGHT_COLOR : v.baseColor);
      v.material.opacity = active ? Math.max(v.baseOpacity, HIGHLIGHT_OPACITY) : v.baseOpacity;
      v.material.transparent = active || v.baseOpacity < 1;
      v.material.depthTest = !active;
      v.object.renderOrder = active ? HIGHLIGHT_RENDER_ORDER : 0;
      if (v.edges) {
        const edgeMaterial = v.edges.material as THREE.LineBasicMaterial;
        edgeMaterial.color.copy(active ? HIGHLIGHT_COLOR : EDGE_COLOR);
        edgeMaterial.depthTest = !active;
        v.edges.renderOrder = active ? HIGHLIGHT_RENDER_ORDER + 1 : 0;
      }
    }
  };

  const tint = (names: readonly string[], color: string | null): void => {
    const wanted = new Set(names);
    for (const v of views) {
      if (!wanted.has(v.name)) continue;
      const target = color === null ? v.baseColor : new THREE.Color(color);
      const glows = v.material.emissive.r + v.material.emissive.g + v.material.emissive.b > 0;
      v.material.color.copy(target);
      if (glows) v.material.emissive.copy(target); // lights glow in their new colour
    }
  };

  sync();
  return { root, sync, setGroupVisible, clip, paint, highlight, tint };
}
