import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ScannedObjectInfo } from '../scene/bundle';
import type { Physics } from '../sim/physics';
import { linearizeVertexColors } from './vertexColors';

// Scanned objects are simulated as convex hulls (geom group 4, not drawn);
// what you see is the SAM 3D mesh riding on the same MuJoCo body.

const HIGHLIGHT_EMISSIVE = new THREE.Color('#ff5a1f');
const HIGHLIGHT_INTENSITY = 0.55;
const NO_EMISSIVE = new THREE.Color(0, 0, 0);

interface ObjectView {
  name: string;
  body: number;
  object: THREE.Group;
  material: THREE.MeshStandardMaterial;
}

export interface ObjectLayer {
  readonly root: THREE.Group;
  sync(): void;
  setVisible(visible: boolean): void;
  highlight(name: string | null): void;
}

async function loadView(
  physics: Physics,
  loader: GLTFLoader,
  baseUrl: string,
  info: ScannedObjectInfo,
): Promise<ObjectView> {
  const { mujoco, model } = physics;
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, info.body);
  if (body < 0) throw new Error(`scene.xml has no body named "${info.body}"`);
  const gltf = await loader.loadAsync(`${baseUrl}${info.mesh}`);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  gltf.scene.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      linearizeVertexColors(node.geometry);
      node.material = material;
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  const object = new THREE.Group();
  object.name = info.name;
  object.matrixAutoUpdate = false;
  object.add(gltf.scene);
  return { name: info.name, body, object, material };
}

export async function loadObjects(
  physics: Physics,
  baseUrl: string,
  objects: ScannedObjectInfo[],
): Promise<ObjectLayer> {
  const loader = new GLTFLoader();
  const views = await Promise.all(objects.map((info) => loadView(physics, loader, baseUrl, info)));
  const root = new THREE.Group();
  root.name = 'scanned-objects';
  for (const v of views) root.add(v.object);

  const sync = (): void => {
    const pos = physics.data.xpos;
    const mat = physics.data.xmat;
    for (const v of views) {
      const p = v.body * 3;
      const r = v.body * 9; // row-major 3x3
      v.object.matrix.set(
        mat[r], mat[r + 1], mat[r + 2], pos[p],
        mat[r + 3], mat[r + 4], mat[r + 5], pos[p + 1],
        mat[r + 6], mat[r + 7], mat[r + 8], pos[p + 2],
        0, 0, 0, 1,
      );
      v.object.matrixWorldNeedsUpdate = true;
    }
  };

  const highlight = (name: string | null): void => {
    for (const v of views) {
      const active = v.name === name;
      v.material.emissive.copy(active ? HIGHLIGHT_EMISSIVE : NO_EMISSIVE);
      v.material.emissiveIntensity = active ? HIGHLIGHT_INTENSITY : 0;
    }
  };

  sync();
  return {
    root,
    sync,
    setVisible: (visible) => {
      root.visible = visible;
    },
    highlight,
  };
}
