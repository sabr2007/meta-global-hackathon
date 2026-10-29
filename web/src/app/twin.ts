// The physical twin of one scan: MuJoCo physics + three.js, with a camera that can sit exactly where
// the iPhone took the hero photo (same pose, same intrinsics) and fly out of the photo and back.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PhotoCamera } from '../ayna/camera';
import { fleetOf, type FleetRobot } from '../ayna/fleet';
import { parseGlb, type TriangleMesh } from '../ayna/glb';
import type { BeforeMask, SceneObject } from '../ayna/goals';
import { buildGeomLayer, GROUP } from '../render/geoms';
import { loadObjects, type ObjectLayer } from '../render/objects';
import { loadRoomMesh } from '../render/roomMesh';
import type { SceneMeta } from '../scene/bundle';
import { createPhysics } from '../sim/loadPhysics';
import { createRobots, type RobotFleet } from '../sim/robots';
import type { Physics } from '../sim/physics';

const BACKGROUND = new THREE.Color('#1b1b1c');
const NEAR = 0.03;
const FAR = 60;
const ORBIT_FOV = 42;
const FLIGHT_MS = 1700;
const RENDER_WIDTH = 720; // render for the verdict and the history, at the photo's aspect
const ROOM_CLIP_HALF_M = 1.5; // keep the scan this far around the table, so the twin reads as a stage
const ROOM_CLIP_TOP_M = 1.3;
const ORBIT_TURN = THREE.MathUtils.degToRad(32);
const ORBIT_PULLBACK = 1.3;
const ORBIT_RISE_M = 0.85; // look down on the table and the floor around it, where the robots work

export type View = 'photo' | 'orbit';

export interface Twin {
  readonly meta: SceneMeta;
  readonly camera: PhotoCamera;
  readonly physics: Physics;
  readonly fleet: FleetRobot[];
  readonly robots: RobotFleet; // the registry robots behind `fleet` (drag placement, reach map)
  readonly objects: SceneObject[];
  readonly before: BeforeMask[];
  readonly meshes: Map<string, TriangleMesh>;
  readonly photoUrl: string;
  readonly canvas: HTMLCanvasElement;
  view: View;
  playing: boolean;
  /** Where the photo is drawn inside the canvas (contain fit), CSS pixels. */
  photoRect(): { x: number; y: number; width: number; height: number };
  fly(to: View, ms?: number): Promise<void>;
  /** The simulation seen from the photo's camera, as a JPEG data URL. */
  renderFromPhoto(): string;
  /** Resolves after `seconds` of simulated time. */
  settle(seconds: number): Promise<void>;
  /** The world point on the horizontal plane z under a pointer position (client pixels). */
  pointOnPlane(clientX: number, clientY: number, z: number): [number, number] | null;
  tintObjects(colors: ReadonlyMap<string, string>): void;
  setOrbitEnabled(enabled: boolean): void;
  /** Centre of the scanned objects (robots face it when placed). */
  readonly focus: [number, number];
  onFrame(listener: () => void): void;
  dispose(): void;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load a scene file (HTTP ${response.status})`);
  return response;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** OpenGL projection for a pinhole camera drawn into a rectangle of a larger canvas. */
function photoProjection(c: PhotoCamera, rect: { x: number; y: number; width: number; height: number }, canvasW: number, canvasH: number): THREE.Matrix4 {
  const sx = rect.width / c.width;
  const sy = rect.height / c.height;
  const fx = c.fx * sx;
  const fy = c.fy * sy;
  const cx = rect.x + c.cx * sx;
  const cy = rect.y + c.cy * sy;
  const m = new THREE.Matrix4();
  m.set(
    (2 * fx) / canvasW, 0, 1 - (2 * cx) / canvasW, 0,
    0, (2 * fy) / canvasH, (2 * cy) / canvasH - 1, 0,
    0, 0, -(FAR + NEAR) / (FAR - NEAR), (-2 * FAR * NEAR) / (FAR - NEAR),
    0, 0, -1, 0,
  );
  return m;
}

export async function loadTwin(canvas: HTMLCanvasElement, files: Record<string, string>): Promise<Twin> {
  const url = (path: string): string => {
    const found = files[path];
    if (!found) throw new Error(`The scan has no ${path}`);
    return found;
  };
  const meta = (await (await fetchOk(url('scene.json'))).json()) as SceneMeta;
  if (!meta.camera || !meta.objects?.length) throw new Error('This scan has no hero photo or objects yet');
  const photoCamera = meta.camera;
  const [mjcf, masksJson] = await Promise.all([
    fetchOk(url(meta.files.mjcf)).then((r) => r.text()),
    fetchOk(url(meta.camera.masks)).then((r) => r.json() as Promise<{ masks: BeforeMask[] }>),
  ]);
  const [physics, room, meshes] = await Promise.all([
    createPhysics(mjcf),
    loadRoomMesh(url(meta.files.mesh)),
    Promise.all(meta.objects.map(async (o) => [o.name, parseGlb(await (await fetchOk(url(o.mesh))).arrayBuffer())] as const)).then((e) => new Map(e)),
  ]);
  physics.advance(0.5); // objects settle onto the table before anyone looks

  THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.background = BACKGROUND;
  scene.add(new THREE.HemisphereLight('#f4f4f6', '#3a3a3e', 1.7));
  const sun = new THREE.DirectionalLight('#ffffff', 1.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const geoms = buildGeomLayer(physics);
  for (const group of [GROUP.structure, GROUP.furniture, GROUP.openings, GROUP.probes]) geoms.setGroupVisible(group, false);
  const objectLayer: ObjectLayer = await loadObjects(physics, url, meta.objects);
  room.setCeilingVisible(false);
  scene.add(room.root, geoms.root, objectLayer.root);

  const objects: SceneObject[] = meta.objects.map((o) => ({ name: o.name, label: o.label, concept: o.concept, size_m: o.size_m, start: o.start }));
  const robotFleet: RobotFleet = createRobots(physics, meta);
  const fleet: FleetRobot[] = fleetOf(physics, robotFleet.robots);

  // Light and orbit around the objects.
  const bounds = new THREE.Box3().setFromObject(objectLayer.root);
  const centre = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.4);
  sun.target.position.copy(centre);
  sun.position.copy(centre).add(new THREE.Vector3(1.2, -1.6, 3));
  Object.assign(sun.shadow.camera, { left: -radius * 2, right: radius * 2, top: radius * 2, bottom: -radius * 2 });
  sun.shadow.camera.updateProjectionMatrix();

  // The LiDAR scan of the whole room is lumpy far from the table: keep a box around the scene.
  const clip = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -(centre.x - ROOM_CLIP_HALF_M)),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), centre.x + ROOM_CLIP_HALF_M),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -(centre.y - ROOM_CLIP_HALF_M)),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), centre.y + ROOM_CLIP_HALF_M),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), ROOM_CLIP_TOP_M),
  ];
  // Out of the photo, the scanned room turns to clay and only the objects keep their colours.
  const clay = { value: 0 };
  room.root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const material = node.material as THREE.MeshStandardMaterial;
    material.clippingPlanes = clip;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uClay = clay;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uClay;')
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n  float clayTone = dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05 + clayTone * 0.42), uClay);',
        );
    };
    material.needsUpdate = true;
  });

  const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, NEAR, FAR);
  const photoPose = new THREE.Matrix4();
  const m = photoCamera.camera_to_world;
  photoPose.set(...(m.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
  const photoPosition = new THREE.Vector3();
  const photoQuaternion = new THREE.Quaternion();
  photoPose.decompose(photoPosition, photoQuaternion, new THREE.Vector3());

  // The orbit view: turned around the table and pulled back, looking at the objects.
  const offset = photoPosition.clone().sub(centre).applyAxisAngle(new THREE.Vector3(0, 0, 1), ORBIT_TURN).multiplyScalar(ORBIT_PULLBACK);
  const orbitPosition = centre.clone().add(offset).add(new THREE.Vector3(0, 0, ORBIT_RISE_M));
  const orbitQuaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(orbitPosition, centre, new THREE.Vector3(0, 0, 1)));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.copy(centre);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.enabled = false;

  let width = 1;
  let height = 1;
  const photoRect = (): { x: number; y: number; width: number; height: number } => {
    const scale = Math.min(width / photoCamera.width, height / photoCamera.height);
    const w = photoCamera.width * scale;
    const h = photoCamera.height * scale;
    return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
  };
  const orbitProjection = (): THREE.Matrix4 => {
    const probe = new THREE.PerspectiveCamera(ORBIT_FOV, width / height, NEAR, FAR);
    probe.updateProjectionMatrix();
    return probe.projectionMatrix.clone();
  };

  let flight: { from: View; to: View; start: number; ms: number; done: () => void } | null = null;
  const state = { view: 'photo' as View, playing: true };
  const place = (blend: number): void => {
    // blend 0 = photo, 1 = orbit
    const t = easeInOut(blend);
    clay.value = t;
    const position = photoPosition.clone().lerp(orbitPosition, t);
    const quaternion = photoQuaternion.clone().slerp(orbitQuaternion, t);
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    camera.updateMatrixWorld(true);
    const a = photoProjection(photoCamera, photoRect(), width, height).elements;
    const b = orbitProjection().elements;
    camera.projectionMatrix.fromArray(a.map((v, i) => v + (b[i] - v) * t));
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };

  const resize = (): void => {
    width = Math.max(canvas.clientWidth, 1);
    height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    if (state.view === 'photo' && !flight) place(0);
    else if (!flight) {
      camera.aspect = width / height;
      camera.fov = ORBIT_FOV;
      camera.updateProjectionMatrix();
    }
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  place(0);

  const listeners: (() => void)[] = [];
  const settlers: { at: number; resolve: () => void }[] = [];
  const control = (): void => robotFleet.update();
  let last = performance.now();
  let frameId = 0;
  const frame = (now: number): void => {
    const elapsed = (now - last) / 1000;
    last = now;
    if (state.playing) physics.advance(elapsed, control);
    for (let i = settlers.length - 1; i >= 0; i -= 1) {
      if (physics.time() >= settlers[i].at) settlers.splice(i, 1)[0].resolve();
    }
    geoms.sync();
    objectLayer.sync();
    if (flight) {
      const s = Math.min((now - flight.start) / flight.ms, 1);
      place(flight.to === 'orbit' ? s : 1 - s);
      if (s >= 1) {
        const done = flight.done;
        state.view = flight.to;
        flight = null;
        if (state.view === 'orbit') {
          camera.fov = ORBIT_FOV;
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          controls.target.copy(centre);
          controls.enabled = true;
        }
        done();
      }
    } else if (state.view === 'orbit') {
      controls.update();
    }
    renderer.render(scene, camera);
    listeners.forEach((l) => l());
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);

  const target = new THREE.WebGLRenderTarget(RENDER_WIDTH, Math.round((RENDER_WIDTH * photoCamera.height) / photoCamera.width), { colorSpace: THREE.SRGBColorSpace });
  const snapshot = new THREE.PerspectiveCamera();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  return {
    meta,
    camera: photoCamera,
    physics,
    fleet,
    robots: robotFleet,
    objects,
    before: masksJson.masks,
    meshes,
    photoUrl: url(photoCamera.image),
    canvas,
    get view() {
      return state.view;
    },
    set view(v: View) {
      state.view = v;
    },
    get playing() {
      return state.playing;
    },
    set playing(v: boolean) {
      state.playing = v;
    },
    photoRect,
    fly(to: View, ms = FLIGHT_MS) {
      if (state.view === to && !flight) return Promise.resolve();
      controls.enabled = false;
      return new Promise<void>((done) => {
        flight = { from: state.view, to, start: performance.now(), ms: reduced.matches ? 1 : ms, done };
      });
    },
    renderFromPhoto() {
      const w = target.width;
      const h = target.height;
      snapshot.position.copy(photoPosition);
      snapshot.quaternion.copy(photoQuaternion);
      snapshot.updateMatrixWorld(true);
      snapshot.projectionMatrix.copy(photoProjection(photoCamera, { x: 0, y: 0, width: w, height: h }, w, h));
      snapshot.projectionMatrixInverse.copy(snapshot.projectionMatrix).invert();
      renderer.setRenderTarget(target);
      renderer.render(scene, snapshot);
      const pixels = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
      renderer.setRenderTarget(null);
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const context = out.getContext('2d')!;
      const image = context.createImageData(w, h);
      for (let row = 0; row < h; row += 1) {
        image.data.set(pixels.subarray((h - 1 - row) * w * 4, (h - row) * w * 4), row * w * 4); // WebGL rows are bottom-up
      }
      context.putImageData(image, 0, 0);
      return out.toDataURL('image/jpeg', 0.86);
    },
    settle(seconds: number) {
      return new Promise<void>((resolve) => settlers.push({ at: physics.time() + seconds, resolve }));
    },
    pointOnPlane(clientX: number, clientY: number, z: number) {
      const box = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
      return hit ? [hit.x, hit.y] : null;
    },
    tintObjects(colors: ReadonlyMap<string, string>) {
      objectLayer.tint(colors);
    },
    setOrbitEnabled(enabled: boolean) {
      // While a robot is dragged, the pointer places it; the wheel still zooms.
      controls.enableRotate = enabled;
      controls.enablePan = enabled;
    },
    focus: [centre.x, centre.y],
    onFrame(listener: () => void) {
      listeners.push(listener);
    },
    dispose() {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      controls.dispose();
      target.dispose();
      renderer.dispose();
      physics.dispose();
    },
  };
}
