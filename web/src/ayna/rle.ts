// Run-length masks, shared by the server (SAM 3.1 output) and the browser (checks, targets, overlays).
// Same layout as `scan2sim.hero.encode_rle`: row-major runs over the mask's own w×h box,
// starting with a (possibly empty) run of 0s.

export interface Rle {
  x: number;
  y: number;
  w: number;
  h: number;
  counts: number[];
}

export interface MaskStats {
  area: number;
  cx: number;
  cy: number;
  box: [number, number, number, number]; // left, top, right, bottom (half-open)
}

export function encodeRle(raster: ArrayLike<number>, x: number, y: number, w: number, h: number): Rle {
  const counts: number[] = [];
  let value = 0;
  let run = 0;
  for (let i = 0; i < w * h; i += 1) {
    const v = raster[i] ? 1 : 0;
    if (v === value) {
      run += 1;
    } else {
      counts.push(run);
      value = v;
      run = 1;
    }
  }
  counts.push(run);
  return { x, y, w, h, counts };
}

export function decodeRle(rle: Rle): Uint8Array {
  const raster = new Uint8Array(rle.w * rle.h);
  let position = 0;
  let value = 0;
  for (const count of rle.counts) {
    if (value) raster.fill(1, position, position + count);
    position += count;
    value ^= 1;
  }
  return raster;
}

/** Calls `visit(x, y)` for every set pixel, in image coordinates. */
export function forEachPixel(rle: Rle, visit: (x: number, y: number) => void): void {
  let position = 0;
  let value = 0;
  for (const count of rle.counts) {
    if (value) {
      for (let i = position; i < position + count; i += 1) visit(rle.x + (i % rle.w), rle.y + Math.floor(i / rle.w));
    }
    position += count;
    value ^= 1;
  }
}

export function maskStats(rle: Rle): MaskStats {
  let area = 0;
  let sx = 0;
  let sy = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  forEachPixel(rle, (x, y) => {
    area += 1;
    sx += x;
    sy += y;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  });
  if (area === 0) return { area: 0, cx: NaN, cy: NaN, box: [0, 0, 0, 0] };
  return { area, cx: sx / area, cy: sy / area, box: [left, top, right + 1, bottom + 1] };
}

/** The mask resampled into another image space (nearest neighbour), e.g. Muse Image's output size
 * back to the hero photo's pixels. */
export function scaleRle(rle: Rle, sx: number, sy: number): Rle {
  const source = decodeRle(rle);
  const x = Math.floor(rle.x * sx);
  const y = Math.floor(rle.y * sy);
  const w = Math.max(1, Math.ceil((rle.x + rle.w) * sx) - x);
  const h = Math.max(1, Math.ceil((rle.y + rle.h) * sy) - y);
  const target = new Uint8Array(w * h);
  for (let row = 0; row < h; row += 1) {
    const sourceRow = Math.min(rle.h - 1, Math.max(0, Math.floor((y + row + 0.5) / sy - rle.y)));
    for (let col = 0; col < w; col += 1) {
      const sourceCol = Math.min(rle.w - 1, Math.max(0, Math.floor((x + col + 0.5) / sx - rle.x)));
      target[row * w + col] = source[sourceRow * rle.w + sourceCol];
    }
  }
  return encodeRle(target, x, y, w, h);
}

/** Intersection over union of two masks in the same image space. */
export function iou(a: Rle, b: Rle): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const areaA = maskStats(a).area;
  const areaB = maskStats(b).area;
  if (right <= left || bottom <= top) return 0;
  const ra = decodeRle(a);
  const rb = decodeRle(b);
  let both = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (ra[(y - a.y) * a.w + (x - a.x)] && rb[(y - b.y) * b.w + (x - b.x)]) both += 1;
    }
  }
  const union = areaA + areaB - both;
  return union > 0 ? both / union : 0;
}

/** Outline pixels (set pixels with an unset 4-neighbour), thinned to roughly one every `step` pixels. */
export function outline(rle: Rle, step = 1): [number, number][] {
  const raster = decodeRle(rle);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= rle.w || y >= rle.h ? 0 : raster[y * rle.w + x]);
  const points: [number, number][] = [];
  for (let y = 0; y < rle.h; y += 1) {
    for (let x = 0; x < rle.w; x += 1) {
      if (!at(x, y)) continue;
      if (at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) continue;
      if (step > 1 && (x + y) % step !== 0) continue;
      points.push([rle.x + x, rle.y + y]);
    }
  }
  return points;
}
