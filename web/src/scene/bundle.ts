// A scene bundle is produced by `scan2sim build` into public/scenes/<id>/.

import type { PhotoCamera } from '../ayna/camera';

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
  top_z: number;
  collides: boolean;
  attributes: Record<string, string>;
}

/** A movable object reconstructed by SAM 3D and placed with LiDAR (`scan2sim objects`). */
export interface ScannedObjectInfo {
  name: string;
  label: string;
  concept: string; // the SAM 3.1 noun phrase that finds it in a photo
  body: string;
  mesh: string;
  size_m: [number, number, number]; // length, width, height
  start: [number, number, number]; // body origin when the scene starts, world metres
  fit_error_mm: number;
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
  keyframe: string;
  grip_site: string;
  gripper: {
    actuator: string;
    open: number; // per finger, m
    fingers: [string, string];
    max_width: number; // widest object the fingers close around, m
    tip_below_grip: number; // fingertips reach this far below the grip point, m
  };
  reach_m: [number, number];
}

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
  room: { label: string | null; floor_m: [number, number] };
  elements: ElementInfo[];
  probes: { name: string; shape: string }[];
  objects?: ScannedObjectInfo[]; // absent in bundles from `scan2sim build`
  arm?: ArmInfo | null;
  camera?: PhotoCamera & { masks: string; alignment: Record<string, { iou: number; centroid_offset_px: number }> }; // the hero photo (scan2sim objects)
  files: { mjcf: string; mesh: string };
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
