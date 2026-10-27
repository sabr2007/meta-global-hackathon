import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { linearizeVertexColors } from './vertexColors';

export interface RoomMesh {
  readonly root: THREE.Object3D;
  /** World bounds of the scanned surfaces (ceiling included). */
  bounds(): THREE.Box3;
  setVisible(visible: boolean): void;
  setCeilingVisible(visible: boolean): void;
}

export async function loadRoomMesh(url: string): Promise<RoomMesh> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  let ceiling: THREE.Object3D | null = null;
  gltf.scene.traverse((node) => {
    if (node.name === 'ceiling') ceiling = node;
    if (node instanceof THREE.Mesh) {
      linearizeVertexColors(node.geometry);
      node.material = material;
      node.receiveShadow = true;
    }
  });

  return {
    root: gltf.scene,
    bounds: () => new THREE.Box3().setFromObject(gltf.scene),
    setVisible: (visible) => {
      gltf.scene.visible = visible;
    },
    setCeilingVisible: (visible) => {
      if (ceiling) (ceiling as THREE.Object3D).visible = visible;
    },
  };
}
