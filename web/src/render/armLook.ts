import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Physics } from '../sim/physics';

// Robot shells are MuJoCo mesh geoms (convex hulls of rounded drums, see pipeline/src/scan2sim/arm.py
// and mobile.py). Colours come from the MJCF materials (robot_look.py); the finish lives here.

const CREASE_ANGLE = THREE.MathUtils.degToRad(35); // keep the sharp seams, smooth the rounded shells

const FINISH: Record<string, THREE.MeshPhysicalMaterialParameters> = {
  // Graphite shells with a satin clear coat, neutral metal, a glowing lime status light.
  robot_shell: { roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.35 },
  robot_panel: { roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.3 },
  robot_seal: { roughness: 0.7 },
  robot_metal: { roughness: 0.32, metalness: 0.6 },
  robot_ok: { roughness: 0.3, emissive: new THREE.Color('#B8FF5E'), emissiveIntensity: 0.6 },
  robot_attention: { roughness: 0.3, emissive: new THREE.Color('#EE7F35'), emissiveIntensity: 0.6 },
  // Bundles built before the robot registry.
  arm_shell: { roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.28 },
  arm_seal: { roughness: 0.62 },
  arm_accent: { roughness: 0.4 },
  arm_finger: { roughness: 0.48, metalness: 0.2 },
};

/** Triangle mesh of a compiled MuJoCo mesh, in the geom's frame. */
export function meshGeometry(physics: Physics, meshId: number): THREE.BufferGeometry {
  const { model } = physics;
  const vertAdr: number = model.mesh_vertadr[meshId];
  const vertNum: number = model.mesh_vertnum[meshId];
  const faceAdr: number = model.mesh_faceadr[meshId];
  const faceNum: number = model.mesh_facenum[meshId];
  // Copy out of WebAssembly memory: views die when the heap grows.
  const positions = Float32Array.from(model.mesh_vert.subarray(vertAdr * 3, (vertAdr + vertNum) * 3));
  const indices = Uint32Array.from(model.mesh_face.subarray(faceAdr * 3, (faceAdr + faceNum) * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return toCreasedNormals(geometry, CREASE_ANGLE);
}

export function armMaterial(physics: Physics, materialId: number): THREE.MeshPhysicalMaterial {
  const { mujoco, model } = physics;
  if (materialId < 0) return new THREE.MeshPhysicalMaterial({ color: '#d9d5cc', roughness: 0.5 });
  const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MATERIAL.value, materialId) ?? '';
  const rgba = model.mat_rgba.subarray(materialId * 4, materialId * 4 + 4);
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace),
    metalness: 0,
    ...FINISH[name],
  });
}
