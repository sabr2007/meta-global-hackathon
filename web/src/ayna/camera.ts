// The hero photo's pinhole camera (exported by scan2sim/hero.py): world <-> upright photo pixels.
// Axes follow three.js: the camera looks down its local -Z, +Y is up in the image.

export type Vec3 = [number, number, number];

export interface PhotoCamera {
  image: string;
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  camera_to_world: number[][]; // 4x4 row-major
}

export interface Ray {
  origin: Vec3;
  direction: Vec3; // unit length
}

function rotation(camera: PhotoCamera): number[][] {
  return camera.camera_to_world.slice(0, 3).map((row) => row.slice(0, 3));
}

export function cameraPosition(camera: PhotoCamera): Vec3 {
  const m = camera.camera_to_world;
  return [m[0][3], m[1][3], m[2][3]];
}

/** World point -> photo pixel and depth along the view axis (negative when behind the camera). */
export function project(camera: PhotoCamera, point: Vec3): { x: number; y: number; depth: number } {
  const r = rotation(camera);
  const t = cameraPosition(camera);
  const d = [point[0] - t[0], point[1] - t[1], point[2] - t[2]];
  // local = R^T d (OpenGL axes); computer-vision axes flip y and z.
  const lx = r[0][0] * d[0] + r[1][0] * d[1] + r[2][0] * d[2];
  const ly = r[0][1] * d[0] + r[1][1] * d[1] + r[2][1] * d[2];
  const lz = r[0][2] * d[0] + r[1][2] * d[1] + r[2][2] * d[2];
  const depth = -lz;
  return { x: (camera.fx * lx) / depth + camera.cx, y: (camera.fy * -ly) / depth + camera.cy, depth };
}

/** The world ray through a photo pixel. */
export function pixelRay(camera: PhotoCamera, x: number, y: number): Ray {
  const r = rotation(camera);
  const local = [(x - camera.cx) / camera.fx, -(y - camera.cy) / camera.fy, -1];
  const world: Vec3 = [0, 1, 2].map((i) => r[i][0] * local[0] + r[i][1] * local[1] + r[i][2] * local[2]) as Vec3;
  const length = Math.hypot(...world);
  return { origin: cameraPosition(camera), direction: world.map((v) => v / length) as Vec3 };
}

/** Where a ray meets the horizontal plane z = height (null when it points away from it). */
export function hitPlane(ray: Ray, height: number): Vec3 | null {
  if (Math.abs(ray.direction[2]) < 1e-9) return null;
  const s = (height - ray.origin[2]) / ray.direction[2];
  if (s <= 0) return null;
  return [ray.origin[0] + s * ray.direction[0], ray.origin[1] + s * ray.direction[1], height];
}
