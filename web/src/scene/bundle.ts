// A scene bundle is produced by `scan2sim build` into public/scenes/<id>/.

export const BUNDLE_FORMAT = 'scan2sim/scene@1';
const SCENE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type Confidence = 'low' | 'medium' | 'high';

export interface ElementInfo {
  name: string;
  kind: 'wall' | 'door' | 'window' | 'opening' | 'object';
  category: string;
  confidence: Confidence;
  dimensions_m: { width: number; depth: number; height: number };
  center: [number, number, number];
  yaw?: number; // heading of the width axis (bundles from before robots[] lack it)
  top_z: number;
  collides: boolean;
  attributes: Record<string, string>;
}

/** A movable object reconstructed by SAM 3D and placed with LiDAR (`scan2sim objects`). */
export interface ScannedObjectInfo {
  name: string;
  label: string;
  body: string;
  mesh: string;
  size_m: [number, number, number]; // length, width, height
  fit_error_mm: number;
}

export interface GripperInfo {
  actuator: string;
  open: number; // per finger, m
  fingers: [string, string];
  max_width: number; // widest object the fingers close around, m
  tip_below_grip: number; // fingertips reach this far below the grip point, m
  palm_above_grip?: number; // the palm starts this far above the grip point, m (0.05 when absent)
}

/** The robot arm placed by `scan2sim objects` (pipeline/src/scan2sim/arm.py). */
export interface ArmInfo {
  base: string;
  position: [number, number, number];
  yaw: number;
  pedestal_m: number;
  support: string | null;
  joints: string[];
  home: number[];
  stow?: number[]; // folded pose, hand over the base (mobile manipulator)
  keyframe: string;
  grip_site: string;
  gripper: GripperInfo;
  reach_m: [number, number];
  mocap?: boolean; // the base is a mocap body: it can be moved at runtime
  footprint_radius?: number;
  status_lights?: string[]; // geoms tinted lime (ok) or orange (attention)
}

/** scene.json `robots[]` (pipeline/src/scan2sim/robots.py). */
export interface ArmRobotInfo extends ArmInfo {
  id: string;
  kind: 'arm';
  label: string;
}

export interface MobileRobotInfo {
  id: string;
  kind: 'mobile';
  label: string;
  base: string; // the chassis body
  position: [number, number, number];
  yaw: number;
  near: string | null;
  reach_m: [number, number];
  gripper: GripperInfo;
  footprint_radius: number;
  nav_margin: number;
  arm_offset_m: number; // the arm's axis stands this far in front of the base centre
  drive: { joints: [string, string, string]; actuators: [string, string, string]; max_speed: number; max_accel: number; max_turn_rate: number };
  lift: { joint: string; actuator: string; range: [number, number]; arm_base_z: [number, number]; home: number };
  arm: ArmInfo;
  keyframe: string;
  status_lights: string[];
}

export type RobotInfo = ArmRobotInfo | MobileRobotInfo;

export interface SceneMeta {
  format: string;
  source: {
    format: string;
    device: string;
    captured_at: string;
    room_name: string;
    photos: number;
    depth_frames: number;
  };
  room: { label: string | null; floor_m: [number, number]; floor_polygon?: [number, number][] | null };
  elements: ElementInfo[];
  probes: { name: string; shape: string }[];
  objects?: ScannedObjectInfo[]; // absent in bundles from `scan2sim build`
  arm?: ArmInfo | null;
  robots?: RobotInfo[]; // every robot (bundles from before the registry only have `arm`)
  files: { mjcf: string; mesh: string };
}

/** The scene's robots; older bundles describe their one arm under `arm`. */
export function robotsOf(meta: SceneMeta): RobotInfo[] {
  if (meta.robots) return meta.robots;
  return meta.arm ? [{ ...meta.arm, id: 'arm', kind: 'arm', label: 'Arm' }] : [];
}

export interface SceneBundle {
  id: string;
  baseUrl: string;
  meta: SceneMeta;
  mjcf: string;
}

export class BundleError extends Error {}

export function sceneIdFromUrl(search: string, fallback: string): string {
  const id = new URLSearchParams(search).get('scene') ?? fallback;
  if (!SCENE_ID_PATTERN.test(id)) {
    throw new BundleError(`Invalid scene id "${id}". Use lowercase letters, digits and dashes.`);
  }
  return id;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new BundleError(`Could not load ${url} (HTTP ${response.status}).`);
  }
  return response;
}

function assertMeta(value: unknown): asserts value is SceneMeta {
  const meta = value as Partial<SceneMeta> | null;
  if (!meta || meta.format !== BUNDLE_FORMAT) {
    throw new BundleError(`scene.json is not a ${BUNDLE_FORMAT} bundle.`);
  }
  if (!Array.isArray(meta.elements) || !meta.files?.mjcf || !meta.files?.mesh) {
    throw new BundleError('scene.json is missing elements or file references.');
  }
}

export async function loadBundle(id: string): Promise<SceneBundle> {
  const baseUrl = `${import.meta.env.BASE_URL}scenes/${id}/`;
  const metaResponse = await fetchOk(`${baseUrl}scene.json`);
  const meta: unknown = await metaResponse.json();
  assertMeta(meta);
  const mjcf = await (await fetchOk(`${baseUrl}${meta.files.mjcf}`)).text();
  return { id, baseUrl, meta, mjcf };
}
