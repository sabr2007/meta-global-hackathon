// Silhouettes without a GPU: project a mesh through the photo camera and fill its triangles.
// Used by the verifier, in the browser and in the Node eval, so both give the same numbers.

import { project, type PhotoCamera } from './camera';
import { encodeRle, type Rle } from './rle';
import type { TriangleMesh } from './glb';

export interface Pose {
  position: [number, number, number];
  rotation: ArrayLike<number>; // row-major 3x3, body -> world
}

/** Boolean mask (as RLE in photo pixels) of a body-frame mesh placed at `pose`. */
export function silhouette(camera: PhotoCamera, mesh: TriangleMesh, pose: Pose): Rle {
  const { positions, indices } = mesh;
  const count = positions.length / 3;
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  const front = new Uint8Array(count);
  const r = pose.rotation;
  const [tx, ty, tz] = pose.position;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const p = project(camera, [r[0] * x + r[1] * y + r[2] * z + tx, r[3] * x + r[4] * y + r[5] * z + ty, r[6] * x + r[7] * y + r[8] * z + tz]);
    px[i] = p.x;
    py[i] = p.y;
    front[i] = p.depth > 0.02 ? 1 : 0;
    if (front[i]) {
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
  }
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(camera.width, Math.ceil(right) + 1);
  const y1 = Math.min(camera.height, Math.ceil(bottom) + 1);
  if (!(x1 > x0 && y1 > y0)) return { x: 0, y: 0, w: 1, h: 1, counts: [1] };
  const w = x1 - x0;
  const h = y1 - y0;
  const raster = new Uint8Array(w * h);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if (!front[a] || !front[b] || !front[c]) continue;
    const minX = Math.max(x0, Math.floor(Math.min(px[a], px[b], px[c])));
    const maxX = Math.min(x1 - 1, Math.ceil(Math.max(px[a], px[b], px[c])));
    const minY = Math.max(y0, Math.floor(Math.min(py[a], py[b], py[c])));
    const maxY = Math.min(y1 - 1, Math.ceil(Math.max(py[a], py[b], py[c])));
    const area = (px[b] - px[a]) * (py[c] - py[a]) - (px[c] - px[a]) * (py[b] - py[a]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y += 1) {
      const sy = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const sx = x + 0.5;
        const w0 = ((px[b] - sx) * (py[c] - sy) - (px[c] - sx) * (py[b] - sy)) / area;
        const w1 = ((px[c] - sx) * (py[a] - sy) - (px[a] - sx) * (py[c] - sy)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) raster[(y - y0) * w + (x - x0)] = 1;
      }
    }
  }
  return encodeRle(raster, x0, y0, w, h);
}
