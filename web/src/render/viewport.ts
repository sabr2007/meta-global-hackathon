import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BACKGROUND = new THREE.Color('#ebe7df');
const SHADOW_MAP_SIZE = 2048;
const EYE_HEIGHT = 0.9; // orbit around roughly table height
const FRAME_PADDING = 0.8; // <1 zooms in past the (generous) bounding sphere
const VIEW_DIRECTION = new THREE.Vector3(0.55, -0.8, 0.8).normalize();
const SUN_OFFSET = new THREE.Vector3(2, -3, 6);

export interface Viewport {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  frame(bounds: THREE.Box3): void;
  render(): void;
}

export function createViewport(canvas: HTMLCanvasElement): Viewport {
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // MuJoCo world is +Z up

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = BACKGROUND;

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
  camera.up.set(0, 0, 1);

  scene.add(new THREE.HemisphereLight('#fffaf0', '#8a8378', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const grid = new THREE.GridHelper(20, 40, '#b9b2a6', '#d4cec4');
  grid.rotateX(Math.PI / 2); // GridHelper lies in XZ; our floor is XY
  grid.position.z = -0.002;
  scene.add(grid);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  const resize = (): void => {
    const { clientWidth, clientHeight } = canvas;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(clientHeight, 1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  return {
    scene,
    camera,
    controls,
    frame(bounds: THREE.Box3): void {
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;

      sun.target.position.copy(center);
      sun.position.copy(center).add(SUN_OFFSET);
      const shadow = sun.shadow.camera;
      shadow.left = -radius;
      shadow.right = radius;
      shadow.top = radius;
      shadow.bottom = -radius;
      shadow.far = SUN_OFFSET.length() + radius * 2;
      shadow.updateProjectionMatrix();

      const distance = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * FRAME_PADDING;
      controls.target.set(center.x, center.y, Math.min(center.z, EYE_HEIGHT));
      camera.position.copy(controls.target).addScaledVector(VIEW_DIRECTION, distance);
      controls.update();
    },
    render(): void {
      controls.update();
      renderer.render(scene, camera);
    },
  };
}
